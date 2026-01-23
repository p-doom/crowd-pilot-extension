import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Buffer } from 'buffer';
import { ConversationStateManager, estimateTokens, getDefaultSystemPrompt } from '@crowd-pilot/serializer';
import { PreviewManager, Action } from './preview';

// -------------------- Preference Data Collection --------------------

interface PreferenceSample {
	timestamp: number;
	context: Array<{ role: string; content: string }>;
	completion: {
		rawModelOutput: string;
		parsedAction: Action | null;
		avgLogprob: number;
	};
	outcome: 'accepted' | 'rejected' | 'ignored' | null;
	outcomeTimestamp: number | null;
	modelName: string;
}

interface PendingPreferenceSample {
	sample: PreferenceSample;
	shownAt: number;
}

let pendingPreferenceSample: PendingPreferenceSample | null = null;

function getPreferenceLogPath(): string {
	const cfg = getConfig();
	if (cfg.preferenceLogPath) {
		return cfg.preferenceLogPath;
	}
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		return path.join(workspaceFolders[0].uri.fsPath, '.crowd-pilot-preferences.jsonl');
	}
	throw new Error("No preference log path found.");
}

/**
 * Log a preference sample to the JSONL file.
 * Each line is a complete JSON object for easy streaming/parsing.
 */
function logPreferenceSample(sample: PreferenceSample): void {
	const cfg = getConfig();
	if (!cfg.enablePreferenceLogging) {
		console.log(`[crowd-pilot] Preference logging disabled, skipping sample`);
		return;
	}

	const logPath = getPreferenceLogPath();
	const line = JSON.stringify(sample) + '\n';
	
	fs.appendFile(logPath, line, (err) => {
		if (err) {
			console.error('[crowd-pilot] Failed to log preference sample:', err);
		} else {
			console.log(`[crowd-pilot] Logged preference sample, outcome: (${sample.outcome})`);
		}
	});
}

/**
 * Create a new pending preference sample when showing a preview.
 * This captures all context needed for reward model training.
 */
function createPendingPreferenceSample(
	conversationMessages: Array<{ role: string; content: string }>,
	rawModelOutput: string,
	parsedAction: Action | null,
	avgLogprob: number,
	modelName: string
): void {
	const sample: PreferenceSample = {
		timestamp: Date.now(),
		context: conversationMessages,
		completion: {
			rawModelOutput,
			parsedAction,
			avgLogprob,
		},
		outcome: null,
		outcomeTimestamp: null,
		modelName,
	};

	pendingPreferenceSample = {
		sample,
		shownAt: Date.now(),
	};
}

/**
 * Record the outcome of the current pending sample and log it.
 */
function recordPreferenceOutcome(outcome: 'accepted' | 'rejected' | 'ignored'): void {
	if (!pendingPreferenceSample) {
		return;
	}

	const sample = pendingPreferenceSample.sample;
	sample.outcome = outcome;
	sample.outcomeTimestamp = Date.now();

	logPreferenceSample(sample);

	pendingPreferenceSample = null;
}

/**
 * Mark any pending sample as ignored (user moved on without explicit accept/reject).
 */
function markPendingAsIgnored(): void {
	if (pendingPreferenceSample) {
		recordPreferenceOutcome('ignored');
	}
}


// Configuration helper
function getConfig() {
	const config = vscode.workspace.getConfiguration('crowd-pilot');
	return {
		hostname: config.get<string>('hostname', 'hai001'),
		port: config.get<number>('port', 30000),
		basePath: config.get<string>('basePath', '/v1/chat/completions'),
		modelName: config.get<string>('modelName', 'qwen/qwen3-8b'),
		minAvgLogprob: config.get<number>('minAvgLogprob', -1.0),
		maxContextTokens: config.get<number>('maxContextTokens', 120000),
		preferenceLogPath: config.get<string>('preferenceLogPath', ''),
		enablePreferenceLogging: config.get<boolean>('enablePreferenceLogging', true),
		viewportRadius: config.get<number>('viewportRadius', 10),
	};
}

// -------------------- Context Window Management --------------------

/**
 * Truncate conversation messages to fit within the context window.
 * Assumes system prompt is the first message.
 * Uses drop-half strategy: when over budget, drops the first half of conversation
 * messages to maximize KV cache hits.
 */
function truncateToContextLimit(
	messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
	maxTokens: number
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
	if (messages.length === 0) { return messages; }

	const systemTokens = estimateTokens(messages[0].content);
	const availableTokens = maxTokens - systemTokens;

	const conversationMessages = messages.slice(1);
	const totalConversationTokens = conversationMessages.reduce(
		(sum, m) => sum + estimateTokens(m.content), 0
	);

	if (totalConversationTokens <= availableTokens) {
		return messages;
	}

	// Drop first half of conversation messages to maximize KV cache hits
	const halfIndex = Math.ceil(conversationMessages.length / 2);
	const keptMessages = conversationMessages.slice(halfIndex);
	const keptTokens = keptMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

	console.log(`[crowd-pilot] Dropped first ${halfIndex} messages (${systemTokens + totalConversationTokens} -> ${systemTokens + keptTokens} tokens)`);
	return [messages[0], ...keptMessages];
}


// Global conversation state manager instance
let conversationManager: ConversationStateManager;

// Track activated files (files whose content we've captured)
// TODO (f.srambical): This logic remains on the extension-side
// for backwards-compatibility (with the crowd-code dataset).
// Eventually, we should move the file tracking logic to
// p-doom/crowd-pilot-serializer.
const activatedFiles = new Set<string>();

/**
 * Clear all conversation context - resets the conversation manager and activated files.
 * Call this to start fresh without accumulated history.
 */
function clearContext(): void {
	conversationManager.reset();
	activatedFiles.clear();
	console.log('[crowd-pilot] Context cleared');
}

let suggestionsEnabled = true;
let statusBarItem: vscode.StatusBarItem | undefined;

function updateStatusBarItem(): void {
	if (!statusBarItem) { return; }
	if (suggestionsEnabled) {
		statusBarItem.text = '$(lightbulb) crowd-pilot';
		statusBarItem.tooltip = 'crowd-pilot: Tab suggestions enabled (click to disable)';
		statusBarItem.backgroundColor = undefined;
	} else {
		statusBarItem.text = '$(lightbulb-autofix) crowd-pilot';
		statusBarItem.tooltip = 'crowd-pilot: Tab suggestions disabled (click to enable)';
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	}
}

export function activate(context: vscode.ExtensionContext) {

	console.log('[crowd-pilot] Extension activated');

	const cfg = getConfig();
	conversationManager = new ConversationStateManager({
		viewportRadius: cfg.viewportRadius,
	});

	previewManager = new PreviewManager();
	previewManager.register(context);

	(async () => {
		const config = vscode.workspace.getConfiguration('terminal.integrated');
		const commandsToSkipShell = config.get<string[]>('commandsToSkipShell', []);
		let updated = false;
		if (!commandsToSkipShell.includes('crowd-pilot.modelRun')) {
			commandsToSkipShell.push('crowd-pilot.modelRun');
			updated = true;
		}
		if (!commandsToSkipShell.includes('crowd-pilot.hideUi')) {
			commandsToSkipShell.push('crowd-pilot.hideUi');
			updated = true;
		}
		if (!commandsToSkipShell.includes('crowd-pilot.showPendingAction')) {
			commandsToSkipShell.push('crowd-pilot.showPendingAction');
			updated = true;
		}
		if (updated) {
			await config.update('commandsToSkipShell', commandsToSkipShell, vscode.ConfigurationTarget.Global);
		}
	})().catch((err) => console.error('[crowd-pilot] Startup initialization error:', err));

	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'crowd-pilot.toggleSuggestions';
	updateStatusBarItem();
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	const toggleSuggestions = vscode.commands.registerCommand('crowd-pilot.toggleSuggestions', () => {
		suggestionsEnabled = !suggestionsEnabled;
		updateStatusBarItem();
		if (!suggestionsEnabled) {
			hidePreviewUI(true);
		}
		vscode.window.showInformationMessage(
			suggestionsEnabled 
				? '[crowd-pilot]: Tab suggestions enabled' 
				: '[crowd-pilot]: Tab suggestions disabled'
		);
	});

	const hideUi = vscode.commands.registerCommand('crowd-pilot.hideUi', () => {
		recordPreferenceOutcome('rejected');
		hidePreviewUI(true);
	});

	const clearContextCmd = vscode.commands.registerCommand('crowd-pilot.clearContext', () => {
		clearContext();
		vscode.window.showInformationMessage('[crowd-pilot]: Context cleared');
	});

	const openPreferenceLogCmd = vscode.commands.registerCommand('crowd-pilot.openPreferenceLog', async () => {
		const logPath = getPreferenceLogPath();
		try {
			const uri = vscode.Uri.file(logPath);
			await vscode.window.showTextDocument(uri);
		} catch (err: any) {
			if (err.code === 'ENOENT' || err.message?.includes('ENOENT')) {
				vscode.window.showInformationMessage('[crowd-pilot] No preference log file exists yet. Accept or reject some suggestions first.');
			} else {
				vscode.window.showErrorMessage(`[crowd-pilot] Error opening preference log: ${err.message}`);
			}
		}
	});

	const modelRun = vscode.commands.registerCommand('crowd-pilot.modelRun', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		try {
			if (!previewManager.isVisible()) { return; }
			let action: Action | undefined = currentAction;
			if (!action) {
				const single = await requestModelActions(editor);
				currentAction = single;
				action = single;
			}
			if (!action) {
				hidePreviewUI();
				return;
			}
			recordPreferenceOutcome('accepted');
			hidePreviewUI(false);
			await executeAction(action);
			autoShowNextAction();
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Model run failed: ${errorMessage}`);
		}
	});

	// Command to show pending action in quick pick (for terminal focus)
	const showPendingAction = vscode.commands.registerCommand('crowd-pilot.showPendingAction', async () => {
		if (!currentAction) {
			vscode.window.showInformationMessage('[crowd-pilot] No pending suggestion');
			return;
		}
		const result = await previewManager.showQuickPick();
		if (result === 'accept') {
			recordPreferenceOutcome('accepted');
			hidePreviewUI(false);
			await executeAction(currentAction);
			autoShowNextAction();
		} else if (result === 'dismiss') {
			recordPreferenceOutcome('rejected');
			hidePreviewUI(true);
		}
	});

	const sglangTest = vscode.commands.registerCommand('crowd-pilot.sglangTest', async () => {
		try {
			await callSGLangChat();
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`SGLang test failed: ${errorMessage}`);
		}
	});

	const onSelChange = vscode.window.onDidChangeTextEditorSelection((e) => {
		if (e.textEditor === vscode.window.activeTextEditor) {
			suppressAutoPreview = false;
			schedulePredictionRefresh(true, false);

			const editor = e.textEditor;
			const selection = e.selections[0];
			if (selection) {
				const filePath = editor.document.uri.fsPath;
				const offset = editor.document.offsetAt(selection.start);
				conversationManager.handleSelectionEvent(filePath, offset);
			}
		}
	});

	const onActiveChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
		suppressAutoPreview = false;
		schedulePredictionRefresh(true, false);

		if (editor) {
			const filePath = editor.document.uri.fsPath;
			const currentFileUri = editor.document.uri.toString();
			let tabEventText: string | null = null;

			if (!activatedFiles.has(currentFileUri)) {
				tabEventText = editor.document.getText();
				activatedFiles.add(currentFileUri);
			}

			conversationManager.handleTabEvent(filePath, tabEventText);
		}
	});

	const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
		if (vscode.window.activeTextEditor?.document === e.document) {
			suppressAutoPreview = false;
			schedulePredictionRefresh(true, false);

			const filePath = e.document.uri.fsPath;
			for (const change of e.contentChanges) {
				const offset = change.rangeOffset;
				const length = change.rangeLength;
				const newText = change.text;
				conversationManager.handleContentEvent(filePath, offset, length, newText);
			}
		}
	});

	// Terminal focus event
	const onTerminalChange = vscode.window.onDidChangeActiveTerminal((terminal) => {
		if (terminal) {
			conversationManager.handleTerminalFocusEvent();
		}
	});

	// Terminal command execution event
	const onTerminalCommand = vscode.window.onDidStartTerminalShellExecution(async (event) => {
		const commandLine = event.execution.commandLine.value;
		conversationManager.handleTerminalCommandEvent(commandLine);

		// Capture terminal output
		const stream = event.execution.read();
		for await (const data of stream) {
			conversationManager.handleTerminalOutputEvent(data);
		}
	});

	context.subscriptions.push(
		toggleSuggestions,
		hideUi,
		clearContextCmd,
		openPreferenceLogCmd,
		sglangTest,
		modelRun,
		showPendingAction,
		onSelChange,
		onActiveChange,
		onDocChange,
		onTerminalChange,
		onTerminalCommand
	);

	// Initialize: capture current active editor if any
	const initialEditor = vscode.window.activeTextEditor;
	if (initialEditor) {
		const filePath = initialEditor.document.uri.fsPath;
		const currentFileUri = initialEditor.document.uri.toString();
		const tabEventText = initialEditor.document.getText();
		activatedFiles.add(currentFileUri);
		conversationManager.handleTabEvent(filePath, tabEventText);
	}
}

export function deactivate() {
	previewManager?.dispose();
}

// -------------------- Execution --------------------
let currentAction: Action | undefined;

function getActiveOrCreateTerminal(): vscode.Terminal {
	if (vscode.window.activeTerminal) {
		return vscode.window.activeTerminal;
	}
	return vscode.window.createTerminal('crowd-pilot');
}

async function executeAction(action: Action): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	const doc = editor.document;
	if (action.kind === 'showTextDocument') {
		await vscode.window.showTextDocument(doc);
		return;
	}
	if (action.kind === 'setSelections') {
		editor.selections = action.selections.map(s => new vscode.Selection(
			new vscode.Position(s.start[0], s.start[1]),
			new vscode.Position(s.end[0], s.end[1])
		));
		editor.revealRange(editor.selections[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		return;
	}
	if (action.kind === 'editInsert') {
		await editor.edit((e: vscode.TextEditorEdit) => e.insert(new vscode.Position(action.position[0], action.position[1]), action.text));
		return;
	}
	if (action.kind === 'editDelete') {
		const range = new vscode.Range(
			new vscode.Position(action.range.start[0], action.range.start[1]),
			new vscode.Position(action.range.end[0], action.range.end[1])
		);
		await editor.edit((e: vscode.TextEditorEdit) => e.delete(range));
		return;
	}
	if (action.kind === 'editReplace') {
		const range = new vscode.Range(
			new vscode.Position(action.range.start[0], action.range.start[1]),
			new vscode.Position(action.range.end[0], action.range.end[1])
		);
		await editor.edit((e: vscode.TextEditorEdit) => e.replace(range, action.text));
		return;
	}
	if (action.kind === 'terminalShow') {
		const term = getActiveOrCreateTerminal();
		term.show();
		return;
	}
	if (action.kind === 'terminalSendText') {
		const term = getActiveOrCreateTerminal();
		term.show();
		term.sendText(action.text, false);
		return;
	}
	if (action.kind === 'openFile') {
		const uri = vscode.Uri.file(action.filePath);
		const openedEditor = await vscode.window.showTextDocument(uri);
		if (action.selections) {
			openedEditor.selections = action.selections.map(s => new vscode.Selection(
				new vscode.Position(s.start[0], s.start[1]),
				new vscode.Position(s.end[0], s.end[1])
			));
			openedEditor.revealRange(openedEditor.selections[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
		return;
	}
}

// -------------------- UI State & Helpers --------------------
const UI_CONTEXT_KEY = 'crowdPilot.uiVisible';
const HAS_PENDING_ACTION_KEY = 'crowdPilot.hasPendingAction';
let previewManager: PreviewManager;
let suppressAutoPreview = false;
let latestRequestId = 0;
let currentAbortController: AbortController | undefined;

const PREDICTION_DEBOUNCE_MS = 150;
const PREDICTION_THROTTLE_MS = 300;

type PendingPrediction = { id: number; timer: NodeJS.Timeout };

let nextQueuedPredictionId = 0;
let pendingPredictions: PendingPrediction[] = [];
const cancelledPredictionIds = new Set<number>();
let lastPredictionTimestamp: number | undefined;

/**
 * Show preview UI for the given action using the PreviewManager.
 */
function showPreviewUI(action: Action): void {
	previewManager.show(action);
	currentAction = action;
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, true);
	vscode.commands.executeCommand('setContext', HAS_PENDING_ACTION_KEY, true);
}

/**
 * Hide the preview UI.
 */
function hidePreviewUI(suppress?: boolean): void {
	previewManager.clear();
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
	vscode.commands.executeCommand('setContext', HAS_PENDING_ACTION_KEY, false);
	if (suppress) {
		suppressAutoPreview = true;
	}
}

/**
 * Schedule a model preview refresh, coalescing rapid editor events and
 * throttling how often we actually talk to the model.
 */
function schedulePredictionRefresh(debounce: boolean, userRequested: boolean): void {
	if (!suggestionsEnabled) {
		return;
	}
	if (!userRequested && suppressAutoPreview) {
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		hidePreviewUI();
		return;
	}

	if (!userRequested) {
		if (!vscode.window.state.focused) {
			hidePreviewUI();
			return;
		}
		if (editor.document.getText().length === 0) {
			hidePreviewUI();
			return;
		}
	}

	const now = Date.now();
	const id = ++nextQueuedPredictionId;

	let delay = 0;
	if (debounce) {
		delay = Math.max(delay, PREDICTION_DEBOUNCE_MS);
	}
	if (lastPredictionTimestamp !== null && lastPredictionTimestamp !== undefined) {
		const elapsed = now - lastPredictionTimestamp;
		if (elapsed < PREDICTION_THROTTLE_MS) {
			delay = Math.max(delay, PREDICTION_THROTTLE_MS - elapsed);
		}
	}

	const timer = setTimeout(() => {
		if (cancelledPredictionIds.has(id)) {
			cancelledPredictionIds.delete(id);
			return;
		}

		lastPredictionTimestamp = Date.now();
		pendingPredictions = pendingPredictions.filter(p => p.id !== id);

		void autoShowNextAction();
	}, delay);

	pendingPredictions.push({ id, timer });

	if (pendingPredictions.length > 2) {
		const oldest = pendingPredictions.shift();
		if (oldest) {
			cancelledPredictionIds.add(oldest.id);
			clearTimeout(oldest.timer);
		}
	}
}

async function autoShowNextAction(): Promise<void> {
	if (suppressAutoPreview) { return; }
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	try {
		currentAbortController?.abort();
		const controller = new AbortController();
		currentAbortController = controller;
		const requestId = ++latestRequestId;
		const next = await requestModelActions(editor, controller.signal);
		if (requestId !== latestRequestId) { return; }
		if (next) { showPreviewUI(next); } else { hidePreviewUI(); }
	} catch (err) {
		const e = err as any;
		const isAbort = e?.name === 'AbortError' || /aborted/i.test(String(e?.message ?? ''));
		if (isAbort) { return; }
		hidePreviewUI();
	}
}

// -------------------- SGLang Client (simple test) --------------------
async function callSGLangChat(): Promise<void> {
	const cfg = getConfig();
	const headers: any = {
		'Content-Type': 'application/json'
	};


	const requestBody: any = {
		model: cfg.modelName,
		messages: [
			{ role: 'user', content: 'What is the capital of France?' }
		]
	};
	requestBody.temperature = 0.7;
	requestBody.top_p = 0.8;
	requestBody.top_k = 20;
	requestBody.min_p = 0;
	requestBody.chat_template_kwargs = {
		enable_thinking: false
	};
	const postData = JSON.stringify(requestBody);
	headers['Content-Length'] = Buffer.byteLength(postData);

	const options = {
		hostname: cfg.hostname,
		port: cfg.port,
		path: cfg.basePath,
		method: 'POST',
		headers
	};


	try {
		const json = await new Promise<any>((resolve, reject) => {
			const req = http.request(options, (res: http.IncomingMessage) => {
				let data = '';
				res.on('data', (chunk: Buffer) => {
					data += chunk.toString();
				});
				res.on('end', () => {
					try {
						resolve(JSON.parse(data));
					} catch (err) {
						reject(new Error(`Failed to parse response: ${err instanceof Error ? err.message : String(err)}`));
					}
				});
			});

			req.on('error', (err: Error) => {
				reject(err);
			});

			req.write(postData);
			req.end();
		});

		vscode.window.showInformationMessage(`Response: ${JSON.stringify(json, null, 2)}`);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Request failed: ${errorMessage}`);
	}
}

// -------------------- Model-planned Actions --------------------
async function requestModelActions(editor: vscode.TextEditor, signal?: AbortSignal): Promise<Action> {
	const cfg = getConfig();
	const headers: any = {
		'Content-Type': 'application/json'
	};

	const doc = editor.document;

	const systemPrompt = getDefaultSystemPrompt(cfg.viewportRadius);

	const accumulatedMessages = conversationManager.finalizeForModel();
	
	let conversationMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
		{ role: 'system', content: systemPrompt },
	];
	
	for (const msg of accumulatedMessages) {
		const role = msg.role === 'user' ? 'user' : 'assistant';
		conversationMessages.push({ role, content: msg.content });
	}

	conversationMessages = truncateToContextLimit(conversationMessages, cfg.maxContextTokens);

	const requestBody: any = {
		model: cfg.modelName,
		messages: conversationMessages
	};
	requestBody.temperature = 0.7;
	requestBody.top_p = 0.8;
	requestBody.top_k = 20;
	requestBody.min_p = 0;
	requestBody.logprobs = true;
	requestBody.chat_template_kwargs = {
		enable_thinking: false
	};

	const postData = JSON.stringify(requestBody);
	headers['Content-Length'] = Buffer.byteLength(postData);

	const options: any = {
		hostname: cfg.hostname,
		port: cfg.port,
		path: cfg.basePath,
		method: 'POST',
		headers
	};
	if (signal) {
		options.signal = signal;
	}

	const json = await new Promise<any>((resolve, reject) => {
		const req = http.request(options, (res: http.IncomingMessage) => {
			let data = '';
			res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
			res.on('end', () => {
				try {
					resolve(JSON.parse(data));
				} catch (err) {
					reject(new Error(`Failed to parse response: ${err instanceof Error ? err.message : String(err)}`));
				}
			});
		});
		req.on('error', (err: Error) => reject(err));
		req.write(postData);
		req.end();
	});

	const avgLogprob = calculateAverageLogprob(json);
	if (avgLogprob < cfg.minAvgLogprob) {
		return undefined as any; // Low confidence, silently skip suggestion
	}

	const content = extractChatContent(json);
	if (typeof content !== 'string' || content.trim().length === 0) {
		throw new Error('Empty model content');
	}
	const action = parseAction(content, doc);
	
	if (!action) {
		throw new Error('No valid action parsed from model output');
	}

	markPendingAsIgnored();

	createPendingPreferenceSample(
		conversationMessages,
		content,
		action,
		avgLogprob,
		cfg.modelName
	);

	return action;
}

function extractChatContent(json: any): string | undefined {
	try {
		if (json && Array.isArray(json.choices) && json.choices[0]) {
			const choice = json.choices[0];
			if (choice.message && typeof choice.message.content === 'string') {
				return choice.message.content;
			}
			if (typeof choice.text === 'string') {
				return choice.text;
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Calculate average logprob per token from the API response.
 * Returns the mean of logprobs across all tokens (negative value, closer to 0 = more confident).
 * Returns -Infinity if logprobs are not available.
 */
function calculateAverageLogprob(json: any): number {
	const logprobs = json.choices[0]?.logprobs;
	const sum = logprobs.content.reduce((s: number, t: any) => s + t.logprob, 0);
	return sum / logprobs.content.length;
}

function parseAction(raw: string, doc?: vscode.TextDocument): Action | undefined {
	const command = extractBashCommand(raw);
	if (!command) {
		return undefined;
	}
	const normalized = command.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
	if (!normalized) {
		return undefined;
	}
	if (doc) {
		const editAction = parseEditFromSedCommand(normalized, doc);
		if (editAction) {
			return editAction;
		}
		const viewportAction = parseViewportFromCatCommand(normalized, doc);
		if (viewportAction) {
			return viewportAction;
		}
	}
	// Sanitize terminal commands for cleaner display
	const sanitizedCommand = sanitizeCommandForDisplay(normalized);
	return { kind: 'terminalSendText', text: sanitizedCommand };
}

/**
 * Sanitize a command string for display, removing shell artifacts and escaping.
 */
function sanitizeCommandForDisplay(cmd: string): string {
	return cmd
		.replace(/^-[A-Z]\s*/gm, '')     // Remove stray flag artifacts at line starts
		.replace(/'\"'\"'/g, "'")         // Fix shell quote escaping
		.replace(/\\\\/g, '\\')           // Normalize double backslashes
		.replace(/\\n/g, '\n')            // Convert escaped newlines
		.replace(/\\t/g, '\t')            // Convert escaped tabs
		.trim();
}

/**
 * Parse a sed-based edit command of the form emitted by the NeMo serializer into a VS Code edit action.
 *
 * Supported patterns (1-based line numbers, mirroring serialization_utils.py):
 *   sed -i 'START,ENDc\n<replacement...>' <file>     -> editReplace
 *   sed -i 'START,ENDd' <file>                      -> editDelete
 *   sed -i 'STARTi\n<insert...>' <file>             -> editInsert (before START)
 *   sed -i '$a\n<append...>' <file>                 -> editInsert (append at EOF)
 *
 * If the command does not match these patterns, returns undefined.
 */
function parseEditFromSedCommand(command: string, doc: vscode.TextDocument): Action | undefined {
	// Only consider the first command before && / ||, since cat -n etc. are for viewport only.
	const main = command.split(/&&|\|\|/)[0]?.trim() ?? '';
	if (!main) {
		return undefined;
	}

	// Match: sed with optional flags like -E, -n, -r, followed by -i, then script and file
	// Handles: sed -i '...' file, sed -E -i '...' file, sed -i -E '...' file, etc.
	const sedMatch = main.match(/sed\s+(?:-[A-Za-z]+\s+)*-i\s+(?:-[A-Za-z]+\s+)*'([\s\S]*?)'\s+([^\s&|]+)\s*$/);
	if (!sedMatch) {
		return undefined;
	}
	const script = sedMatch[1] ?? '';
	const targetFile = sedMatch[2] ?? '';
	const activePath = doc.uri.fsPath;
	if (targetFile !== activePath) {
		return undefined;
	}

	// Delete: "START,ENDd"
	const deleteMatch = script.match(/^(\d+),(\d+)d$/);
	if (deleteMatch) {
		const startLine1 = Number(deleteMatch[1]);
		const endLine1 = Number(deleteMatch[2]);
		if (!Number.isFinite(startLine1) || !Number.isFinite(endLine1)) {
			return undefined;
		}
		const startLine0 = Math.max(0, startLine1 - 1);
		const endLine0 = Math.max(0, endLine1 - 1);

		let endPosLine = endLine0 + 1;
		let endPosChar = 0;
		if (endPosLine >= doc.lineCount) {
			endPosLine = doc.lineCount - 1;
			endPosChar = doc.lineAt(endPosLine).range.end.character;
		}
		return {
			kind: 'editDelete',
			range: {
				start: [startLine0, 0],
				end: [endPosLine, endPosChar],
			},
		};
	}

	// Replace: "START,ENDc\newline<payload...>"
	const replaceMatch = script.match(/^(\d+),(\d+)c\\\n([\s\S]*)$/);
	if (replaceMatch) {
		const startLine1 = Number(replaceMatch[1]);
		const endLine1 = Number(replaceMatch[2]);
		let payload = replaceMatch[3] ?? '';
		if (!Number.isFinite(startLine1) || !Number.isFinite(endLine1)) {
			return undefined;
		}
		payload = payload.replace(/'\"'\"'/g, "'");
		// Convert escape sequences to actual characters
		payload = payload.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
		const startLine0 = Math.max(0, startLine1 - 1);
		const endLine0 = Math.max(0, endLine1 - 1);
		const startPos: [number, number] = [startLine0, 0];

		let endPosLine = endLine0 + 1;
		let endPosChar = 0;
		if (endPosLine >= doc.lineCount) {
			endPosLine = doc.lineCount - 1;
			endPosChar = doc.lineAt(endPosLine).range.end.character;
		}

		const text = payload.endsWith('\n') ? payload : payload + '\n';
		return {
			kind: 'editReplace',
			range: { start: startPos, end: [endPosLine, endPosChar] },
			text,
		};
	}

	const insertMatch = script.match(/^(\d+)i\\\n([\s\S]*)$/);
	if (insertMatch) {
		const line1 = Number(insertMatch[1]);
		let payload = insertMatch[2] ?? '';
		if (!Number.isFinite(line1)) {
			return undefined;
		}
		payload = payload.replace(/'\"'\"'/g, "'");
		// Convert escape sequences to actual characters
		payload = payload.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
		const insertLine0 = Math.max(0, line1 - 1);
		const position: [number, number] = [insertLine0, 0];
		const text = payload.endsWith('\n') ? payload : payload + '\n';
		return {
			kind: 'editInsert',
			position,
			text,
		};
	}

	const appendMatch = script.match(/^\$a\\\n([\s\S]*)$/);
	if (appendMatch) {
		let payload = appendMatch[1] ?? '';
		payload = payload.replace(/'\"'\"'/g, "'");
		// Convert escape sequences to actual characters
		payload = payload.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
		const insertLine0 = doc.lineCount;
		const position: [number, number] = [insertLine0, 0];
		const needsLeadingNewline = doc.lineCount > 0;
		const base = payload.endsWith('\n') ? payload : payload + '\n';
		const text = needsLeadingNewline ? '\n' + base : base;
		return {
			kind: 'editInsert',
			position,
			text,
		};
	}

	return undefined;
}

/**
 * Parse viewport / selection commands of the form:
 *   cat -n <file> | sed -n 'START,ENDp'
 *
 * into a lightweight VS Code selection move (setSelections). This mirrors how
 * selection and viewport events are serialized in serialization_utils.py.
 */
function parseViewportFromCatCommand(command: string, doc: vscode.TextDocument): Action | undefined {
	const main = command.split(/&&|\|\|/)[0]?.trim() ?? '';
	if (!main) {
		return undefined;
	}

	// Simple file-open: cat -n <file>
	const simpleCatMatch = main.match(/^cat\s+-n\s+([^\s|]+)\s*$/);
	if (simpleCatMatch) {
		const targetFile = simpleCatMatch[1] ?? '';
		if (targetFile !== doc.uri.fsPath) {
			return { kind: 'openFile', filePath: targetFile };
		}
		// Ensure the active document is visible; rely on existing editor to handle this.
		return { kind: 'showTextDocument' };
	}

	// Viewport slice: cat -n <file> | sed -n 'START,ENDp'
	const viewportMatch = main.match(/^cat\s+-n\s+([^\s|]+)\s*\|\s*sed\s+-n\s+'(\d+),(\d+)p'\s*$/);
	if (!viewportMatch) {
		return undefined;
	}

	const targetFile = viewportMatch[1] ?? '';
	const startStr = viewportMatch[2] ?? '';
	const endStr = viewportMatch[3] ?? '';

	const startLine1 = Number(startStr);
	const endLine1 = Number(endStr);

	// Place the cursor in the middle of the viewport (1-based to 0-based).
	const center1 = Math.floor((startLine1 + endLine1) / 2);
	const center0 = Math.max(0, center1 - 1);

	if (targetFile !== doc.uri.fsPath) {
		return {
			kind: 'openFile',
			filePath: targetFile,
			selections: [{ start: [center0, 0], end: [center0, 0] }]
		};
	}
	const lastLine = Math.max(0, doc.lineCount - 1);
	const line = Math.min(center0, lastLine);

	return {
		kind: 'setSelections',
		selections: [
			{
				start: [line, 0],
				end: [line, 0],
			},
		],
	};
}

function extractBashCommand(raw: string): string | undefined {
	if (!raw) {
		return undefined;
	}
	const trimmed = raw.trim();
	const fenceMatch = trimmed.match(/```(?:bash)?\s*([\s\S]*?)```/i);
	if (fenceMatch && fenceMatch[1]) {
		return fenceMatch[1];
	}
	// Fallback: treat entire response as the command
	return trimmed.length > 0 ? trimmed : undefined;
}