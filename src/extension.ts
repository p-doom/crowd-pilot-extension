import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Buffer } from 'buffer';
import { ConversationStateManager, estimateTokens, getDefaultSystemPrompt } from '@crowd-pilot/serializer';

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

type Action =
| { kind: 'showTextDocument' }
| { kind: 'setSelections', selections: Array<{ start: [number, number], end: [number, number] }> }
| { kind: 'editInsert', position: [number, number], text: string }
| { kind: 'editDelete', range: { start: [number, number], end: [number, number] } }
| { kind: 'editReplace', range: { start: [number, number], end: [number, number] }, text: string }
| { kind: 'terminalShow' }
| { kind: 'terminalSendText', text: string }
| { kind: 'openFile', filePath: string, selections?: Array<{ start: [number, number], end: [number, number] }> };

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
 * Assumes system prompt is the first message. Drops oldest conversation messages first.
 */
function truncateToContextLimit(
	messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
	maxTokens: number
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
	if (messages.length === 0) { return messages; }

	const systemTokens = estimateTokens(messages[0].content);
	const availableTokens = maxTokens - systemTokens;

	const tokenCounts = messages.slice(1).map(m => estimateTokens(m.content));
	const totalConversationTokens = tokenCounts.reduce((a, b) => a + b, 0);

	if (totalConversationTokens <= availableTokens) {
		return messages;
	}

	let keptTokens = 0;
	let cutoffIndex = tokenCounts.length;
	for (let i = tokenCounts.length - 1; i >= 0; i--) {
		if (keptTokens + tokenCounts[i] <= availableTokens) {
			keptTokens += tokenCounts[i];
			cutoffIndex = i;
		} else {
			break;
		}
	}

	console.log(`[crowd-pilot] Truncated ${cutoffIndex} oldest messages (${systemTokens + totalConversationTokens} -> ${systemTokens + keptTokens} tokens)`);
	return [messages[0], ...messages.slice(cutoffIndex + 1)];
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
			if (!previewVisible) { return; }
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

export function deactivate() {}

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
let previewVisible = false;
let decorationDeleteType: vscode.TextEditorDecorationType | undefined;
let decorationReplaceType: vscode.TextEditorDecorationType | undefined;
let decorationReplaceBlockType: vscode.TextEditorDecorationType | undefined;
let mockStep = 0;
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

function disposePreviewDecorations() {
	try { decorationDeleteType?.dispose(); } catch {}
	try { decorationReplaceType?.dispose(); } catch {}
	try { decorationReplaceBlockType?.dispose(); } catch {}
	decorationDeleteType = undefined;
	decorationReplaceType = undefined;
	decorationReplaceBlockType = undefined;
}

function getDynamicMargin(editor: vscode.TextEditor, anchorLine: number, text: string): string {
	const lines = text.split(/\r?\n/);
	const height = lines.length;
	
	// We need to check the document lines that will be covered by this panel.
	// The panel starts at 'anchorLine' and extends downwards by 'height' lines.
	// However, visually, since it's 'after', it sits to the right of 'anchorLine',
	// and then flows down.
	// So we check document lines from anchorLine to anchorLine + height - 1.
	
	const doc = editor.document;
	let maxLen = 0;
	const startLine = anchorLine;
	const endLine = Math.min(doc.lineCount - 1, anchorLine + height - 1);
	
	for (let i = startLine; i <= endLine; i++) {
		const lineText = doc.lineAt(i).text;
		const len = lineText.replace(/\t/g, '    ').length;
		if (len > maxLen) {
			maxLen = len;
		}
	}
	
	const anchorLineText = doc.lineAt(anchorLine).text;
	const anchorLen = anchorLineText.replace(/\t/g, '    ').length;
	
	const diff = Math.max(0, maxLen - anchorLen);
	const margin = diff + 4; 
	return `${margin}ch`;
}

function showPreviewUI(action: Action): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	disposePreviewDecorations();

	const next = (action.kind === 'editInsert' || action.kind === 'editDelete' || action.kind === 'editReplace' || action.kind === 'terminalSendText' || action.kind === 'setSelections' || action.kind === 'openFile') ? action : undefined;
	if (!next) {
		previewVisible = false;
		vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
		currentAction = action;
		return;
	}

	const trimText = (t: string) => {
		const oneLine = t.replace(/\r?\n/g, '\\n');
		return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;
	};

	if (next.kind === 'setSelections') {
		const selection = next.selections[0];
		const targetPos = new vscode.Position(selection.start[0], selection.start[1]);
		const isVisible = editor.visibleRanges.some(r => r.contains(targetPos));
		
		let anchorPos = targetPos;
		let label = "↳ Move Cursor Here";

		if (!isVisible && editor.visibleRanges.length > 0) {
			const firstVisible = editor.visibleRanges[0].start;
			const lastVisible = editor.visibleRanges[editor.visibleRanges.length - 1].end;
			
			if (targetPos.isBefore(firstVisible)) {
				anchorPos = new vscode.Position(firstVisible.line, Number.MAX_VALUE);
			} else {
				anchorPos = new vscode.Position(lastVisible.line, Number.MAX_VALUE);
			}

			if (targetPos.line < anchorPos.line) {
				label = `↑ Move Cursor to Line ${targetPos.line + 1}`;
			} else {
				label = `↓ Move Cursor to Line ${targetPos.line + 1}`;
			}
		}

		const margin = getDynamicMargin(editor, anchorPos.line, label);

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "${label}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top;`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(anchorPos, anchorPos) }]);
	} else if (next.kind === 'terminalSendText') {
		const cursor = editor.selection.active;
		const isVisible = editor.visibleRanges.some(r => r.contains(cursor));
		
		let anchorPos = new vscode.Position(cursor.line, Number.MAX_VALUE);
		
		if (!isVisible && editor.visibleRanges.length > 0) {
			const firstVisible = editor.visibleRanges[0].start;
			const lastVisible = editor.visibleRanges[editor.visibleRanges.length - 1].end;
			
			if (cursor.isBefore(firstVisible)) {
				anchorPos = new vscode.Position(firstVisible.line, Number.MAX_VALUE);
			} else {
				anchorPos = new vscode.Position(lastVisible.line, Number.MAX_VALUE);
			}
		}
		
		const summary = trimText(next.text || '');
		const label = `↳ Execute shell command in terminal: ${summary}`;
		const margin = getDynamicMargin(editor, anchorPos.line, label);

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "${label.replace(/"/g, '\\"')}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top;`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(anchorPos, anchorPos) }]);
	} else if (next.kind === 'editInsert') {
		const posLine = next.position[0];
		const fullBlock = next.text;
		const cssContent = fullBlock
			.replace(/"/g, '\\"')
			.replace(/\r?\n/g, '\\A ');

		const docLineCount = editor.document.lineCount;
		let anchorLine = posLine;
		let shiftUp = true;
		
		if (anchorLine >= docLineCount) {
			anchorLine = docLineCount - 1;
			shiftUp = false;
		}

		const anchorPos = new vscode.Position(anchorLine, Number.MAX_VALUE); 
		
		const marginCheckLine = anchorLine;
		const margin = getDynamicMargin(editor, marginCheckLine, fullBlock);

		const topOffset = '0';

		const beforeDecoration = {
			contentText: '',
			textDecoration: `none; position: absolute; left: 0; width: 100vw; border-top: 1px dashed var(--vscode-charts-purple); top: 0; height: 0; z-index: 99; pointer-events: none;`
		};

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			before: beforeDecoration,
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "${cssContent}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top; top: ${topOffset};`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(anchorPos, anchorPos) }]);
	} else if (next.kind === 'editDelete') {
		const range = new vscode.Range(
			new vscode.Position(next.range.start[0], next.range.start[1]),
			new vscode.Position(next.range.end[0], next.range.end[1])
		);
		decorationDeleteType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(255, 60, 60, 0.18)',
			border: '1px solid rgba(255, 60, 60, 0.35)',
			textDecoration: 'line-through'
		});
		editor.setDecorations(decorationDeleteType, [{ range }]);
	} else if (next.kind === 'editReplace') {
		const range = new vscode.Range(
			new vscode.Position(next.range.start[0], next.range.start[1]),
			new vscode.Position(next.range.end[0], next.range.end[1])
		);
		decorationReplaceType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(255,165,0,0.15)',
			border: '1px dashed rgba(255,165,0,0.45)',
			color: new vscode.ThemeColor('disabledForeground'),
			textDecoration: 'line-through'
		});
		editor.setDecorations(decorationReplaceType, [{ range }]);

		const fullBlock = next.text;
		
		const cssContent = fullBlock
			.replace(/"/g, '\\"')
			.replace(/\r?\n/g, '\\A '); 

		const anchorLine = range.start.line;
		const anchorPos = new vscode.Position(anchorLine, Number.MAX_VALUE);
		const margin = getDynamicMargin(editor, anchorLine, fullBlock);

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "${cssContent}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top;`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(anchorPos, anchorPos) }]);
	} else if (next.kind === 'openFile') {
		const cursor = editor.selection.active;
		const isVisible = editor.visibleRanges.some(r => r.contains(cursor));
		
		let anchorPos = new vscode.Position(cursor.line, Number.MAX_VALUE);
		
		if (!isVisible && editor.visibleRanges.length > 0) {
			const firstVisible = editor.visibleRanges[0].start;
			const lastVisible = editor.visibleRanges[editor.visibleRanges.length - 1].end;
			
			if (cursor.isBefore(firstVisible)) {
				anchorPos = new vscode.Position(firstVisible.line, Number.MAX_VALUE);
			} else {
				anchorPos = new vscode.Position(lastVisible.line, Number.MAX_VALUE);
			}
		}
		
		const fileName = next.filePath.split(/[/\\]/).pop() || next.filePath;
		const targetLine = next.selections?.[0]?.start[0];
		const label = targetLine !== undefined
			? `↳ Switch to file: ${fileName}:${targetLine + 1}` // Display as 1-based
			: `↳ Switch to file: ${fileName}`;
		const margin = getDynamicMargin(editor, anchorPos.line, label);

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "${label.replace(/"/g, '\\"')}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top;`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(anchorPos, anchorPos) }]);
	}

	previewVisible = true;
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, true);
	currentAction = action;
}

function hidePreviewUI(suppress?: boolean): void {
	disposePreviewDecorations();
	previewVisible = false;
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
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
		const role = msg.from === 'User' ? 'user' : 'assistant';
		conversationMessages.push({ role, content: msg.value });
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
	return { kind: 'terminalSendText', text: normalized };
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

	// Match: sed -i '<script>' <file>
	const sedMatch = main.match(/sed\s+-i\s+'([\s\S]*?)'\s+([^\s&|]+)\s*$/);
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