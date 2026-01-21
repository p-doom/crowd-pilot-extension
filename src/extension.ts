import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Buffer } from 'buffer';
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
		preferenceLogPath: config.get<string>('preferenceLogPath', ''),
		enablePreferenceLogging: config.get<boolean>('enablePreferenceLogging', true),
		viewportRadius: config.get<number>('viewportRadius', 10),
	};
}

type LineRange = { start: number; end: number };
type EditHistoryEvent = { oldPath: string; path: string; diff: string };
type LastEditEvent = {
	oldText: string;
	newText: string;
	editRange: LineRange;
	lastEditTimeMs: number;
};

const EDIT_HISTORY_LIMIT = 6;
const CHANGE_GROUPING_LINE_SPAN = 8;
const LAST_CHANGE_GROUPING_TIME_MS = 1000;
const DIFF_CONTEXT_LINES = 3;
const BYTES_PER_TOKEN_GUESS = 3;
const MAX_EDITABLE_TOKENS = 180;
const MAX_CONTEXT_TOKENS = 350;

const fileTextByUri = new Map<string, string>();
const editHistoryByUri = new Map<string, EditHistoryEvent[]>();
const lastEditByUri = new Map<string, LastEditEvent>();

function clearContext(): void {
	fileTextByUri.clear();
	editHistoryByUri.clear();
	lastEditByUri.clear();
	currentAction = undefined;
	lastPredictionContext = null;
	hidePreviewUI(true);
	currentAbortController?.abort();
	currentAbortController = undefined;
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
const TEACHER_PROMPT_TEMPLATE = `# Instructions

You are an edit prediction assistant in a code editor. Your task is to predict the next edit to a given region of code surrounding the user's cursor.

1. Analyze the edit history to understand what the programmer is trying to achieve
2. Identify any incomplete refactoring or changes that need to be finished
3. Make the remaining edits that a human programmer would logically make next (by rewriting the code around their cursor)

## Focus on

- Completing any partially-applied changes made
- Ensuring consistency with the programming style and patterns already established
- Making edits that maintain or improve code quality

## Rules

- Do not just mechanically apply patterns - reason about what changes make sense given the context and the programmer's apparent goals.
- Do not just fix syntax errors - look for the broader refactoring pattern and apply it systematically throughout the code.
- Keep existing formatting unless it's absolutely necessary
- Don't write a lot of code if you're not sure what to do

# Input Format

You will be provided with:
1. The user's *edit history*, in chronological order. Use this to infer the user's trajectory and predict the next most logical edit.
2. A set of *related excerpts* from the user's codebase. Some of these may be needed for correctly predicting the next edit.
  - \`…\` may appear within a related file to indicate that some code has been skipped.
3. An excerpt from the user's *current file*.
    - Within the user's current file, there is an *editable region* delimited by the \`<|editable_region_start|>\` and \`<|editable_region_end|>\` tags. You can only predict edits in this region.
    - The \`<|user_cursor|>\` tag marks the user's current cursor position, as it stands after the last edit in the history.

# Output Format

- Briefly explain the user's current intent based on the edit history and their current cursor location.
- Output the entire editable region, applying the edits that you predict the user will make next.
- If you're unsure some portion of the next edit, you may still predict the surrounding code (such as a function definition, \`for\` loop, etc) and place the \`<|user_cursor|>\` within it for the user to fill in.
- Wrap the edited code in a codeblock with exactly five backticks.

## Example

### Input

\`\`\`\`\`
struct Product {
    name: String,
    price: u32,
}

fn calculate_total(products: &[Product]) -> u32 {
<|editable_region_start|>
    let mut total = 0;
    for product in products {
        total += <|user_cursor|>;
    }
    total
<|editable_region_end|>
}
\`\`\`\`\`

### Output

The user is computing a sum based on a list of products. The only numeric field on \`Product\` is \`price\`, so they must intend to sum the prices.

\`\`\`\`\`
    let mut total = 0;
    for product in products {
        total += product.price;
    }
    total
\`\`\`\`\`

# 1. User Edits History

\`\`\`\`\`
{{edit_history}}
\`\`\`\`\`

# 2. Related excerpts

{{context}}

# 3. Current File

{{cursor_excerpt}}
`;

const EDITABLE_REGION_START_LINE = "<|editable_region_start|>";
const EDITABLE_REGION_END_LINE = "<|editable_region_end|>";
const USER_CURSOR_MARKER = "<|user_cursor|>";

export function activate(context: vscode.ExtensionContext) {

	console.log('[crowd-pilot] Extension activated');
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
		}
	});

	const onActiveChange = vscode.window.onDidChangeActiveTextEditor(() => {
		suppressAutoPreview = false;
		seedDocumentState();
		schedulePredictionRefresh(true, false);
	});
	const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
		if (vscode.window.activeTextEditor?.document === e.document) {
			suppressAutoPreview = false;
			recordDocumentChange(e.document);
			schedulePredictionRefresh(true, false);
		}
	});

	const onActiveChange = vscode.window.onDidChangeActiveTextEditor(() => {
		suppressAutoPreview = false;
		seedDocumentState();
		schedulePredictionRefresh(true, false);
	});
	const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
		if (vscode.window.activeTextEditor?.document === e.document) {
			suppressAutoPreview = false;
			recordDocumentChange(e.document);
			schedulePredictionRefresh(true, false);
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
		onDocChange
	);

	seedDocumentState();
	schedulePredictionRefresh(true, false);
}

export function deactivate() {
	previewManager?.dispose();
}

// -------------------- Execution --------------------
let currentAction: Action | undefined;
type PredictionContext = {
	docUri: string;
	docVersion: number;
	editableRange: LineRange;
	cursorLine: number;
};
let lastPredictionContext: PredictionContext | null = null;

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

function canRequestPrediction(editor: vscode.TextEditor, userRequested: boolean): boolean {
	if (!userRequested && suppressAutoPreview) {
		return false;
	}
	if (!userRequested) {
		if (!vscode.window.state.focused) {
			return false;
		}
		if (editor.document.getText().length === 0) {
			return false;
		}
		if (editor.selections.some(selection => !selection.isEmpty)) {
			return false;
		}
	}
	return true;
}

function shouldReuseCurrentPrediction(editor: vscode.TextEditor): boolean {
	if (!currentAction || !previewManager.isVisible()) {
		return false;
	}
	if (!lastPredictionContext) {
		return false;
	}
	const doc = editor.document;
	if (doc.uri.toString() !== lastPredictionContext.docUri) {
		return false;
	}
	if (doc.version !== lastPredictionContext.docVersion) {
		return false;
	}
	if (editor.selections.some(selection => !selection.isEmpty)) {
		return false;
	}
	const cursorLine = editor.selection.active.line;
	return cursorLine >= lastPredictionContext.editableRange.start
		&& cursorLine <= lastPredictionContext.editableRange.end;
}

/**
 * Schedule a model preview refresh, coalescing rapid editor events and
 * throttling how often we actually talk to the model.
 */
function schedulePredictionRefresh(debounce: boolean, userRequested: boolean): void {
	if (!suggestionsEnabled) {
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		hidePreviewUI();
		return;
	}

	if (!canRequestPrediction(editor, userRequested)) {
		hidePreviewUI();
		return;
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

function seedDocumentState(): void {
	for (const editor of vscode.window.visibleTextEditors) {
		const doc = editor.document;
		const uri = doc.uri.toString();
		if (!fileTextByUri.has(uri)) {
			fileTextByUri.set(uri, doc.getText());
		}
	}
}

function recordDocumentChange(doc: vscode.TextDocument): void {
	const uri = doc.uri.toString();
	const newText = doc.getText();
	const oldText = fileTextByUri.get(uri);
	if (oldText === undefined) {
		fileTextByUri.set(uri, newText);
		return;
	}
	if (oldText === newText) {
		return;
	}
	const changedRange = computeChangedLineRange(oldText, newText);
	if (!changedRange) {
		fileTextByUri.set(uri, newText);
		return;
	}

	const nowMs = Date.now();
	const lastEvent = lastEditByUri.get(uri);
	if (lastEvent && nowMs - lastEvent.lastEditTimeMs >= LAST_CHANGE_GROUPING_TIME_MS) {
		finalizeLastEdit(uri, doc.fileName, lastEvent);
	}

	const updatedLastEvent = lastEditByUri.get(uri);
	if (
		updatedLastEvent &&
		rangesAreNearby(updatedLastEvent.editRange, changedRange, CHANGE_GROUPING_LINE_SPAN)
	) {
		updatedLastEvent.newText = newText;
		updatedLastEvent.editRange = {
			start: Math.min(updatedLastEvent.editRange.start, changedRange.start),
			end: Math.max(updatedLastEvent.editRange.end, changedRange.end),
		};
		updatedLastEvent.lastEditTimeMs = nowMs;
		lastEditByUri.set(uri, updatedLastEvent);
	} else {
		if (updatedLastEvent) {
			finalizeLastEdit(uri, doc.fileName, updatedLastEvent);
		}
		lastEditByUri.set(uri, {
			oldText,
			newText,
			editRange: changedRange,
			lastEditTimeMs: nowMs,
		});
	}

	fileTextByUri.set(uri, newText);
}

function finalizeLastEdit(uri: string, filePath: string, lastEvent: LastEditEvent): void {
	const diff = buildUnifiedDiff(lastEvent.oldText, lastEvent.newText, DIFF_CONTEXT_LINES);
	if (!diff.trim()) {
		lastEditByUri.delete(uri);
		return;
	}
	const events = editHistoryByUri.get(uri) ?? [];
	events.push({ oldPath: filePath, path: filePath, diff });
	while (events.length > EDIT_HISTORY_LIMIT) {
		events.shift();
	}
	editHistoryByUri.set(uri, events);
	lastEditByUri.delete(uri);
}

function rangesAreNearby(a: LineRange, b: LineRange, span: number): boolean {
	if (a.start <= b.end && b.start <= a.end) {
		return true;
	}
	if (a.start > b.end) {
		return (a.start - b.end) <= span;
	}
	return (b.start - a.end) <= span;
}

function computeChangedLineRange(oldText: string, newText: string): LineRange | undefined {
	const oldLines = oldText.split(/\r?\n/);
	const newLines = newText.split(/\r?\n/);
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}
	if (prefix === oldLines.length && prefix === newLines.length) {
		return undefined;
	}
	const endLine = Math.max(prefix, newLines.length - suffix - 1);
	return { start: prefix, end: Math.max(prefix, endLine) };
}

function buildUnifiedDiff(oldText: string, newText: string, contextLines: number): string {
	const oldLines = oldText.split(/\r?\n/);
	const newLines = newText.split(/\r?\n/);
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}
	if (prefix === oldLines.length && prefix === newLines.length) {
		return "";
	}
	const oldStart = Math.max(0, prefix - contextLines);
	const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + contextLines);
	const newStart = Math.max(0, prefix - contextLines);
	const newEnd = Math.min(newLines.length, newLines.length - suffix + contextLines);
	const oldLen = Math.max(0, oldEnd - oldStart);
	const newLen = Math.max(0, newEnd - newStart);

	const diffLines: string[] = [];
	diffLines.push(`@@ -${oldStart + 1},${oldLen} +${newStart + 1},${newLen} @@`);

	const prefixContext = oldLines.slice(oldStart, prefix);
	for (const line of prefixContext) {
		diffLines.push(` ${line}`);
	}
	const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
	for (const line of oldChanged) {
		diffLines.push(`-${line}`);
	}
	const newChanged = newLines.slice(prefix, newLines.length - suffix);
	for (const line of newChanged) {
		diffLines.push(`+${line}`);
	}
	const suffixContext = oldLines.slice(oldLines.length - suffix, oldEnd);
	for (const line of suffixContext) {
		diffLines.push(` ${line}`);
	}

	return diffLines.join("\n");
}
async function autoShowNextAction(): Promise<void> {
	if (suppressAutoPreview) { return; }
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	if (!canRequestPrediction(editor, false)) {
		hidePreviewUI();
		return;
	}
	if (shouldReuseCurrentPrediction(editor)) {
		return;
	}
	try {
		currentAbortController?.abort();
		const controller = new AbortController();
		currentAbortController = controller;
		const requestId = ++latestRequestId;
		const next = await requestModelActions(editor, controller.signal);
		if (requestId !== latestRequestId) { return; }
		if (next) {
			if (currentAction && previewManager.isVisible() && !shouldReplaceAction(currentAction, next)) {
				return;
			}
			showPreviewUI(next);
		} else {
			hidePreviewUI();
		}
	} catch (err) {
		const e = err as any;
		const isAbort = e?.name === 'AbortError' || /aborted/i.test(String(e?.message ?? ''));
		if (isAbort) { return; }
		hidePreviewUI();
	}
}

function shouldReplaceAction(currentAction: Action, nextAction: Action): boolean {
	if (currentAction.kind !== nextAction.kind) {
		return true;
	}
	if (currentAction.kind === 'editReplace' && nextAction.kind === 'editReplace') {
		const sameRange =
			currentAction.range.start[0] === nextAction.range.start[0] &&
			currentAction.range.start[1] === nextAction.range.start[1] &&
			currentAction.range.end[0] === nextAction.range.end[0] &&
			currentAction.range.end[1] === nextAction.range.end[1];
		if (!sameRange) {
			return true;
		}
		return !nextAction.text.startsWith(currentAction.text);
	}
	if (currentAction.kind === 'setSelections' && nextAction.kind === 'setSelections') {
		const current = currentAction.selections[0];
		const next = nextAction.selections[0];
		if (!current || !next) {
			return true;
		}
		return !(
			current.start[0] === next.start[0] &&
			current.start[1] === next.start[1] &&
			current.end[0] === next.end[0] &&
			current.end[1] === next.end[1]
		);
	}
	return true;
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
async function requestModelActions(editor: vscode.TextEditor, signal?: AbortSignal): Promise<Action | undefined> {
	const cfg = getConfig();
	const headers: any = {
		'Content-Type': 'application/json'
	};

	const promptContext = buildTeacherPrompt(editor);
	const conversationMessages = [
		{ role: 'system', content: promptContext.prompt }
	];

	const requestBody: any = {
		model: cfg.modelName,
		messages: conversationMessages,
		temperature: 0.7,
		top_p: 0.8,
		top_k: 20,
		min_p: 0,
		logprobs: true,
		chat_template_kwargs: {
			enable_thinking: false
		}
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

	const content = extractChatContent(json);
	if (typeof content !== 'string' || content.trim().length === 0) {
		throw new Error('Empty model content');
	}
	const action = parseTeacherResponse(content, promptContext);
	if (!action) {
		return undefined;
	}
	lastPredictionContext = {
		docUri: promptContext.doc.uri.toString(),
		docVersion: promptContext.doc.version,
		editableRange: promptContext.editableRange,
		cursorLine: promptContext.cursor.line,
	};

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
	const logprobs = json?.choices?.[0]?.logprobs;
	const tokens = logprobs?.content;
	if (!Array.isArray(tokens) || tokens.length === 0) {
		return Number.NEGATIVE_INFINITY;
	}
	let sum = 0;
	let count = 0;
	for (const token of tokens) {
		if (typeof token.logprob === 'number') {
			sum += token.logprob;
			count += 1;
		}
	}
	if (count === 0) {
		return Number.NEGATIVE_INFINITY;
	}
	return sum / count;
}

type PromptContext = {
	prompt: string;
	editableRange: LineRange;
	editableText: string;
	doc: vscode.TextDocument;
	cursor: vscode.Position;
};

function buildTeacherPrompt(editor: vscode.TextEditor): PromptContext {
	const doc = editor.document;
	const lines = doc.getText().split(/\r?\n/);
	const cursor = editor.selection.active;
	const { editable, context } = computeEditableAndContextRanges(lines, cursor.line);

	const historyEvents = collectEditHistoryForPrompt(doc, doc.uri.toString());
	const editHistoryText = formatEditHistory(historyEvents);
	const relatedContextText = formatRelatedContext(doc);
	const cursorExcerpt = formatCursorExcerpt(doc, editable, context, cursor);

	const prompt = TEACHER_PROMPT_TEMPLATE
		.replace('{{edit_history}}', editHistoryText)
		.replace('{{context}}', relatedContextText)
		.replace('{{cursor_excerpt}}', cursorExcerpt);

	const editableText = lines.slice(editable.start, editable.end + 1).join('\n');
	return { prompt, editableRange: editable, editableText, doc, cursor };
}

function collectEditHistoryForPrompt(doc: vscode.TextDocument, uri: string): EditHistoryEvent[] {
	const events = [...(editHistoryByUri.get(uri) ?? [])];
	const lastEvent = lastEditByUri.get(uri);
	if (lastEvent) {
		const diff = buildUnifiedDiff(lastEvent.oldText, lastEvent.newText, DIFF_CONTEXT_LINES);
		if (diff.trim()) {
			events.push({ oldPath: doc.fileName, path: doc.fileName, diff });
		}
	}
	return events.slice(-EDIT_HISTORY_LIMIT);
}

function formatEditHistory(events: EditHistoryEvent[]): string {
	if (events.length === 0) {
		return "(No edit history)";
	}
	return events
		.map((event) => `--- a/${event.oldPath}\n+++ b/${event.path}\n${event.diff}`)
		.join("\n");
}

function formatRelatedContext(currentDoc: vscode.TextDocument): string {
	const relatedEditors = vscode.window.visibleTextEditors.filter(
		(editor) => editor.document.uri.toString() !== currentDoc.uri.toString(),
	);
	if (relatedEditors.length === 0) {
		return "(No context)";
	}

	const blocks: string[] = [];
	for (const editor of relatedEditors) {
		const doc = editor.document;
		const path = doc.fileName;
		const totalLines = doc.lineCount;
		const cursorLine = editor.selection.active.line;
		const radius = 10;
		const start = Math.max(0, cursorLine - radius);
		const end = Math.min(totalLines - 1, cursorLine + radius);
		const excerptLines: string[] = [];

		if (start > 0) {
			excerptLines.push("…");
		}
		for (let line = start; line <= end; line += 1) {
			excerptLines.push(doc.lineAt(line).text);
		}
		if (end < totalLines - 1) {
			excerptLines.push("…");
		}

		const block = [
			`\`\`\`\`\`${path}`,
			excerptLines.join("\n"),
			"",
			"`````",
		].join("\n");
		blocks.push(block);
	}

	return blocks.join("\n");
}

function formatCursorExcerpt(
	doc: vscode.TextDocument,
	editable: LineRange,
	context: LineRange,
	cursor: vscode.Position,
): string {
	const lines = doc.getText().split(/\r?\n/);
	const contextStart = Math.max(0, context.start);
	const contextEnd = Math.min(lines.length - 1, context.end);
	const excerptLines = lines.slice(contextStart, contextEnd + 1);

	const cursorIndex = cursor.line - contextStart;
	if (cursorIndex >= 0 && cursorIndex < excerptLines.length) {
		const lineText = excerptLines[cursorIndex];
		const charIndex = Math.min(cursor.character, lineText.length);
		excerptLines[cursorIndex] =
			lineText.slice(0, charIndex) + USER_CURSOR_MARKER + lineText.slice(charIndex);
	}

	const editableStartIndex = editable.start - contextStart;
	const editableEndIndex = editable.end - contextStart;
	const startInsertIndex = Math.max(0, Math.min(excerptLines.length, editableStartIndex));
	excerptLines.splice(startInsertIndex, 0, EDITABLE_REGION_START_LINE);
	const endInsertIndex = Math.max(0, Math.min(excerptLines.length, editableEndIndex + 2));
	excerptLines.splice(endInsertIndex, 0, EDITABLE_REGION_END_LINE);

	return `\`\`\`\`\`${doc.fileName}\n${excerptLines.join("\n")}\n\`\`\`\`\``;
}

function computeEditableAndContextRanges(
	lines: string[],
	cursorLine: number,
): { editable: LineRange; context: LineRange } {
	const clampedLine = Math.max(0, Math.min(cursorLine, Math.max(0, lines.length - 1)));
	const cursorRange = { start: clampedLine, end: clampedLine };
	const editable = expandLineRange(lines, cursorRange, MAX_EDITABLE_TOKENS);
	const context = expandLineRange(lines, editable, MAX_CONTEXT_TOKENS);
	return { editable, context };
}

function expandLineRange(lines: string[], base: LineRange, tokenLimit: number): LineRange {
	let start = Math.max(0, base.start);
	let end = Math.min(lines.length - 1, base.end);
	let remaining = tokenLimit;

	for (let line = start; line <= end; line += 1) {
		remaining -= lineTokenGuess(lines[line]);
	}
	remaining = Math.max(0, remaining);

	while (remaining > 0) {
		let expanded = false;
		if (start > 0 && remaining > 0) {
			start -= 1;
			remaining -= lineTokenGuess(lines[start]);
			expanded = true;
		}
		if (end < lines.length - 1 && remaining > 0) {
			end += 1;
			remaining -= lineTokenGuess(lines[end]);
			expanded = true;
		}
		if (!expanded) {
			break;
		}
	}

	return { start, end };
}

function lineTokenGuess(line: string): number {
	const bytes = Buffer.byteLength(line, "utf8");
	return Math.max(1, Math.floor(bytes / BYTES_PER_TOKEN_GUESS));
}

function parseTeacherResponse(raw: string, context: PromptContext): Action | undefined {
	const codeBlock = extractLastCodeBlock(raw);
	if (!codeBlock) {
		return undefined;
	}
	const cleaned = stripEditableMarkers(codeBlock);
	let newEditableText = cleaned.replace(new RegExp(USER_CURSOR_MARKER, "g"), "");
	if (context.editableText.endsWith("\n") && !newEditableText.endsWith("\n")) {
		newEditableText += "\n";
	}
	if (context.editableText === newEditableText) {
		return undefined;
	}
	const changeRange = computeChangedLineRange(context.editableText, newEditableText);
	if (!changeRange) {
		return undefined;
	}
	const absoluteStart = context.editableRange.start + changeRange.start;
	const absoluteEnd = context.editableRange.start + changeRange.end;
	const cursorLine = context.cursor.line;

	if (cursorLine < absoluteStart - 2 || cursorLine > absoluteEnd + 2) {
		const targetLine = Math.max(0, Math.min(absoluteStart, context.doc.lineCount - 1));
		return {
			kind: "setSelections",
			selections: [{ start: [targetLine, 0], end: [targetLine, 0] }],
		};
	}

	const endLine = Math.min(context.editableRange.end, context.doc.lineCount - 1);
	const endChar = context.doc.lineAt(endLine).range.end.character;
	return {
		kind: "editReplace",
		range: { start: [context.editableRange.start, 0], end: [endLine, endChar] },
		text: newEditableText,
	};
}

function stripEditableMarkers(text: string): string {
	const lines = text.split(/\r?\n/);
	const filtered = lines.filter((line) => {
		const trimmed = line.trim();
		return trimmed !== EDITABLE_REGION_START_LINE && trimmed !== EDITABLE_REGION_END_LINE;
	});
	return filtered.join("\n");
}

function extractLastCodeBlock(text: string): string | undefined {
	let lastBlock: string | undefined;
	let searchStart = 0;

	while (true) {
		const start = text.indexOf("```", searchStart);
		if (start === -1) {
			break;
		}
		let end = start;
		while (end < text.length && text[end] === "`") {
			end += 1;
		}
		const fence = text.slice(start, end);
		const lineBreak = text.indexOf("\n", end);
		if (lineBreak === -1) {
			break;
		}
		const closing = text.indexOf(`\n${fence}`, lineBreak + 1);
		if (closing === -1) {
			searchStart = end;
			continue;
		}
		lastBlock = text.slice(lineBreak + 1, closing + 1);
		searchStart = closing + fence.length + 1;
	}

	return lastBlock?.trim();
}
