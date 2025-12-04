import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { Buffer } from 'buffer';


const SGLANG_HOSTNAME = 'hai007';
const SGLANG_PORT = 30000;
const SGLANG_BASE_PATH = '/v1/chat/completions';
const SGLANG_MODEL_NAME = 'qwen/qwen3-0.6b';

const GEMINI_HOSTNAME = 'generativelanguage.googleapis.com';
const GEMINI_PORT = 443;
const GEMINI_BASE_PATH = '/v1beta/openai/chat/completions';
const GEMINI_MODEL_NAME = 'gemini-2.5-flash';

const USE_GEMINI = false;

export function activate(context: vscode.ExtensionContext) {

	console.log('[crowd-pilot] Extension activated');

	// Configure terminal to allow tab keybinding to work
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

	const hideUi = vscode.commands.registerCommand('crowd-pilot.hideUi', () => {
		hidePreviewUI(true);
	});

	const modelRun = vscode.commands.registerCommand('crowd-pilot.modelRun', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		try {
			// Confirm only when a suggestion is visible
			if (!previewVisible) { return; }
			let action: PlannedAction | undefined = currentAction;
			if (!action) {
				const single = await requestModelActions(editor);
				currentAction = single;
				action = single;
			}
			if (!action) {
				hidePreviewUI();
				return;
			}
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

	// Auto-preview listeners
	const debouncedAutoPreview = debounce(() => {
		autoShowNextAction();
	}, 250);
	const onSelChange = vscode.window.onDidChangeTextEditorSelection((e) => {
		if (e.textEditor === vscode.window.activeTextEditor) {
			suppressAutoPreview = false;
			debouncedAutoPreview();
		}
	});
	const onActiveChange = vscode.window.onDidChangeActiveTextEditor(() => {
		suppressAutoPreview = false;
		debouncedAutoPreview();
	});
	const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
		if (vscode.window.activeTextEditor?.document === e.document) {
			suppressAutoPreview = false;
			debouncedAutoPreview();
		}
	});

	context.subscriptions.push(hideUi, sglangTest, modelRun, onSelChange, onActiveChange, onDocChange);
}

export function deactivate() {}

// -------------------- Plan Types & Execution --------------------
type PlannedAction =
| { kind: 'showTextDocument' }
| { kind: 'setSelections', selections: Array<{ start: [number, number], end: [number, number] }> }
| { kind: 'editInsert', position: [number, number], text: string }
| { kind: 'editDelete', range: { start: [number, number], end: [number, number] } }
| { kind: 'editReplace', range: { start: [number, number], end: [number, number] }, text: string }
| { kind: 'terminalShow' }
| { kind: 'terminalSendText', text: string };

let currentAction: PlannedAction | undefined;

async function executeAction(action: PlannedAction): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	const doc = editor.document;
	const term = vscode.window.terminals[0] ?? vscode.window.createTerminal('Test');
	if (action.kind === 'showTextDocument') {
		await vscode.window.showTextDocument(doc);
		return;
	}
	if (action.kind === 'setSelections') {
		editor.selections = action.selections.map(s => new vscode.Selection(
			new vscode.Position(s.start[0], s.start[1]),
			new vscode.Position(s.end[0], s.end[1])
		));
		if (editor.selections.length > 0) {
			editor.revealRange(editor.selections[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
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
		term.show();
		return;
	}
	if (action.kind === 'terminalSendText') {
		term.sendText(action.text);
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

function disposePreviewDecorations() {
	try { decorationDeleteType?.dispose(); } catch {}
	try { decorationReplaceType?.dispose(); } catch {}
	try { decorationReplaceBlockType?.dispose(); } catch {}
	decorationDeleteType = undefined;
	decorationReplaceType = undefined;
	decorationReplaceBlockType = undefined;
}

function debounce<T extends (...args: any[]) => void>(fn: T, waitMs: number) {
	let timer: NodeJS.Timeout | undefined;
	return (...args: Parameters<T>) => {
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => fn(...args), waitMs);
	};
}

function getDynamicMargin(editor: vscode.TextEditor, anchorLine: number, text: string): string {
	// Count lines in the preview text
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
		// Simple approximation: assume tabs are 4 spaces if we can't get config easily, 
		// or just treat them as 1 char (which might underestimate). 
		// Better to overestimate: treat tab as 4 chars.
		const len = lineText.replace(/\t/g, '    ').length;
		if (len > maxLen) {
			maxLen = len;
		}
	}
	
	// Length of the anchor line itself
	const anchorLineText = doc.lineAt(anchorLine).text;
	const anchorLen = anchorLineText.replace(/\t/g, '    ').length;
	
	// The offset needed is maxLen - anchorLen.
	// If maxLen <= anchorLen, offset is 0 (margin is just base padding).
	// If maxLen > anchorLen, we need to push right by (maxLen - anchorLen).
	
	const diff = Math.max(0, maxLen - anchorLen);
	// Base margin 2rem is roughly 4ch. Let's use ch units for everything to be consistent.
	// 1ch is width of '0'. In monospace, mostly consistent.
	// Add 3ch extra padding for safety/visual gap.
	const margin = diff + 4; 
	return `${margin}ch`;
}

function showPreviewUI(action: PlannedAction): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	disposePreviewDecorations();

	// FIXME (f.srambical): add file switch 
	const next = (action.kind === 'editInsert' || action.kind === 'editDelete' || action.kind === 'editReplace' || action.kind === 'terminalSendText' || action.kind === 'setSelections') ? action : undefined;
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
		// For setSelections, we only preview the primary selection's start/active position
		const selection = next.selections[0];
		const targetPos = new vscode.Position(selection.start[0], selection.start[1]);
		// Check if the target position is visible
		const isVisible = editor.visibleRanges.some(r => r.contains(targetPos));
		
		let anchorPos = targetPos;
		let label = "↳ Move Cursor Here";

		if (!isVisible && editor.visibleRanges.length > 0) {
			const firstVisible = editor.visibleRanges[0].start;
			const lastVisible = editor.visibleRanges[editor.visibleRanges.length - 1].end;
			
			if (targetPos.isBefore(firstVisible)) {
				anchorPos = editor.document.lineAt(firstVisible.line).range.end;
			} else {
				anchorPos = editor.document.lineAt(lastVisible.line).range.end;
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
		const lineEnd = editor.document.lineAt(cursor.line).range.end;
		const summary = trimText(next.text || '');
		const label = `↳ Execute shell command in terminal: ${summary}`;
		const margin = getDynamicMargin(editor, cursor.line, label);

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
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(lineEnd, lineEnd) }]);
	} else if (next.kind === 'editInsert') {
		const posLine = next.position[0];
		const fullBlock = next.text;
		const cssContent = fullBlock
			.replace(/"/g, '\\"')
			.replace(/\r?\n/g, '\\A ');

		const docLineCount = editor.document.lineCount;
		// If inserting at EOF (or beyond), attach to the last line.
		// Otherwise, attach to the line AT the insertion point and shift visually UP into the gap.
		let anchorLine = posLine;
		let shiftUp = true;
		
		if (anchorLine >= docLineCount) {
			anchorLine = docLineCount - 1;
			shiftUp = false; // At EOF, we just append below or to the right
		}

		const anchorPos = new vscode.Position(anchorLine, Number.MAX_VALUE); 
		
		// We attach to the line AT the insertion point.
		// The panel floats to the right of this line.
		// The dashed line connects the start of this line to the panel.
		// This indicates that the new text will be inserted at this line position (pushing the current line down).
		const marginCheckLine = anchorLine;
		const margin = getDynamicMargin(editor, marginCheckLine, fullBlock);

		const topOffset = '0';

		// Dashed line style
		// We use 'before' decoration for the line.
		// It needs to be absolute, full width (or enough to reach left), 
		// and aligned with the panel top.
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
		// Highlight original range (to be replaced)
		decorationReplaceType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(255,165,0,0.15)',
			border: '1px dashed rgba(255,165,0,0.45)',
			color: new vscode.ThemeColor('disabledForeground'),
			textDecoration: 'line-through'
		});
		editor.setDecorations(decorationReplaceType, [{ range }]);

		// Show replacement block to the right of the first replaced line
		const fullBlock = next.text;
		
		// CSS-escape the text for the 'content' property:
		// - Escape double quotes
		// - Replace newlines with \A (CSS newline)
		const cssContent = fullBlock
			.replace(/"/g, '\\"')
			.replace(/\r?\n/g, '\\A '); 

		// Attach 'after' decoration to the start of the replacement range
		// (Actually, attaching to the end of the first line is safer for 'after')
		const anchorLine = range.start.line;
		const anchorPos = new vscode.Position(anchorLine, Number.MAX_VALUE);
		const margin = getDynamicMargin(editor, anchorLine, fullBlock);

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: '', // Handled by CSS content
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "${cssContent}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top;`
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

// -------------------- Hardcoded single-step actions --------------------
function getHardcodedNextAction(editor: vscode.TextEditor): PlannedAction | undefined {
	const cursor = editor.selection.active;
	const doc = editor.document;
	const lineCount = doc.lineCount;
	const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

	// Step 0: Insert multiline content two lines below the cursor (start of target line)
	if (mockStep === 0) {
		const targetLine = clamp(cursor.line + 2, 0, Math.max(0, lineCount - 1));
		return {
			kind: 'editInsert',
			position: [targetLine, 0],
			text: '/* crowd-pilot: insert start */\nline A\nline B\n/* crowd-pilot: insert end */\n'
		};
	}
	// Step 1: Replace a two-line range three and four lines below the cursor
	if (mockStep === 1) {
		const startLine = clamp(cursor.line + 3, 0, Math.max(0, lineCount - 1));
		const endLine = clamp(startLine + 1, 0, Math.max(0, lineCount - 1));
		const endChar = doc.lineAt(endLine).range.end.character;
		const range = {
			start: [startLine, 0] as [number, number],
			end: [endLine, endChar] as [number, number]
		};
		const replacement = [
			'/* crowd-pilot: replacement */',
			'REPLACED LINE 1',
			'REPLACED LINE 2'
		].join('\n');
		return { kind: 'editReplace', range, text: replacement };
	}
	// Step 2: Delete a three-line range six to eight lines below the cursor
	if (mockStep === 2) {
		const startLine = clamp(cursor.line + 6, 0, Math.max(0, lineCount - 1));
		const endLine = clamp(startLine + 2, 0, Math.max(0, lineCount - 1));
		
		// To fully delete the lines including the newline, we target the start of the next line.
		let endPosLine = endLine + 1;
		let endPosChar = 0;
		
		if (endPosLine >= lineCount) {
			// If deleting the last line(s), just go to the end of the document
			endPosLine = lineCount - 1;
			endPosChar = doc.lineAt(endPosLine).range.end.character;
		}

		const range = {
			start: [startLine, 0] as [number, number],
			end: [endPosLine, endPosChar] as [number, number]
		};
		return { kind: 'editDelete', range };
	}
	// Step 3: Execute in Terminal
	if (mockStep === 3) {
		return { kind: 'terminalSendText', text: 'echo "Hello World"' };
	}
	// Step 4: Move Cursor to End of File
	if (mockStep === 4) {
		const lastLine = doc.lineCount - 1;
		const lastChar = doc.lineAt(lastLine).range.end.character;
		return {
			kind: 'setSelections',
			selections: [{ start: [lastLine, lastChar], end: [lastLine, lastChar] }]
		};
	}
	return undefined;
}

function advanceMockStep(): void {
	mockStep = (mockStep + 1) % 5;
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
	const config = vscode.workspace.getConfiguration();
	
	let hostname: string;
	let port: number;
	let path: string;
	let useHttps = true;
	let modelName: string;
	const headers: any = {
		'Content-Type': 'application/json'
	};

	if (!USE_GEMINI) {
		// SGLang
		hostname = SGLANG_HOSTNAME;
		port = SGLANG_PORT;
		path = SGLANG_BASE_PATH;
		useHttps = false; 
		modelName = SGLANG_MODEL_NAME;
	} else {
		// Gemini
		const apiKey = config.get<string>('crowd-pilot.apiKey');
		if (!apiKey) {
			vscode.window.showErrorMessage('Crowd Pilot: Please set your API Key in settings (crowd-pilot.apiKey).');
			return;
		}
		hostname = GEMINI_HOSTNAME;
		port = GEMINI_PORT;
		path = GEMINI_BASE_PATH;
		headers['Authorization'] = `Bearer ${apiKey}`;
		modelName = GEMINI_MODEL_NAME;
	}

	const requestBody: any = {
		model: modelName,
		messages: [
			{ role: 'user', content: 'What is the capital of France?' }
		]
	};
	if (!USE_GEMINI) {
		requestBody.temperature = 0.7;
		requestBody.top_p = 0.8;
		requestBody.top_k = 20;
		requestBody.min_p = 0;
		requestBody.extra_body = {
			chat_template_kwargs: {
				enable_thinking: false
			}
		};
	}
	const postData = JSON.stringify(requestBody);
	headers['Content-Length'] = Buffer.byteLength(postData);

	const options = {
		hostname,
		port,
		path,
		method: 'POST',
		headers
	};

	const requestModule = useHttps ? https : http;

	try {
		const json = await new Promise<any>((resolve, reject) => {
			const req = requestModule.request(options, (res: http.IncomingMessage) => {
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

// -------------------- Prompt Serialization Helpers --------------------
function formatStdoutBlock(content: string): string {
	const normalized = content ?? '';
	return `<stdout>\n${normalized}\n</stdout>`;
}

function formatLineNumberedOutput(content: string, startLine?: number, endLine?: number): string {
	const lines = content.split(/\r?\n/);
	const total = (lines.length === 1 && lines[0] === '') ? 0 : lines.length;
	if (total === 0) {
		return '';
	}
	const s = startLine !== undefined ? Math.max(1, Math.min(startLine, total)) : 1;
	const e = endLine !== undefined ? Math.max(s, Math.min(endLine, total)) : total;
	const buf: string[] = [];
	for (let idx = s; idx <= e; idx++) {
		const lineText = lines[idx - 1] ?? '';
		buf.push(`${idx.toString().padStart(6, ' ')}\t${lineText}`);
	}
	return buf.join('\n');
}

function computeViewport(totalLines: number, centerLine: number, radius: number): { start: number; end: number } {
	if (totalLines <= 0) {
		return { start: 1, end: 0 };
	}
	const start = Math.max(1, centerLine - radius);
	const end = Math.min(totalLines, centerLine + radius);
	return { start, end };
}

function fencedBashBlock(command: string): string {
	const cleaned = command.replace(/\r/g, '').trim();
	return `\`\`\`bash\n${cleaned}\n\`\`\``;
}

// -------------------- Model-planned Actions --------------------
async function requestModelActions(editor: vscode.TextEditor, signal?: AbortSignal): Promise<PlannedAction> {
	const config = vscode.workspace.getConfiguration();
	
	let hostname: string;
	let port: number;
	let path: string;
	let useHttps = true;
	let modelName: string;
	const headers: any = {
		'Content-Type': 'application/json'
	};

	if (!USE_GEMINI) {
		// SGLang
		hostname = SGLANG_HOSTNAME;
		port = SGLANG_PORT;
		path = SGLANG_BASE_PATH;
		useHttps = false;
		modelName = SGLANG_MODEL_NAME;
	} else {
		// Gemini
		const apiKey = config.get<string>('crowd-pilot.apiKey');
		if (!apiKey) {
			vscode.window.showErrorMessage('Crowd Pilot: Please set your API Key in settings (crowd-pilot.apiKey).');
			throw new Error('API key not set');
		}
		hostname = GEMINI_HOSTNAME;
		port = GEMINI_PORT;
		path = GEMINI_BASE_PATH;
		headers['Authorization'] = `Bearer ${apiKey}`;
		modelName = GEMINI_MODEL_NAME;
	}

	const doc = editor.document;
	const cursor = editor.selection.active;
	const fullText = doc.getText();
	const filePath = doc.uri.fsPath;
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(unknown)';
	const cursorLine = cursor.line + 1;
	const cursorColumn = cursor.character + 1;
	const totalLines = doc.lineCount;
	const viewport = computeViewport(totalLines, cursorLine, 12);
	const metadataSummary = [
		`Workspace root: ${workspaceRoot}`,
		`Active file: ${filePath}`,
		`Language: ${doc.languageId}`,
		`Cursor (1-based): line ${cursorLine}, column ${cursorColumn}`
	].join('\n');
	const metadataCommand = [
		"cat <<'EOF'",
		metadataSummary,
		'EOF'
	].join('\n');

	const systemPrompt = [
		'You are a helpful assistant that can interact multiple times with a computer shell to solve programming tasks.',
		'Your response must contain exactly ONE bash code block with ONE command (or commands connected with && or ||).',
		'',
		'Format your response as shown in <format_example>.',
		'',
		'<format_example>',
		'```bash',
		'your_command_here',
		'```',
		'</format_example>',
		'',
		'Failure to follow these rules will cause your response to be rejected.',
		'',
		'=== EDIT COMMAND FORMAT (IMPORTANT) ===',
		'When you want to EDIT a file, you MUST encode the edit using line-based sed commands in ONE of the following forms,',
		'and you MUST NOT use substitution commands like "Ns/old/new/g".',
		'',
		'Assume all line numbers are 1-based and paths are absolute.',
		'Allowed edit encodings (choose exactly one per response):',
		'',
		'1) Replace a contiguous block of lines:',
		"   sed -i 'START,ENDc\\",
		'NEW_LINE_1',
		'NEW_LINE_2',
		"...",
		"' /abs/path/to/file && cat -n /abs/path/to/file | sed -n 'VSTART,VENDp'",
		'',
		'2) Delete a contiguous block of lines:',
		"   sed -i 'START,ENDd' /abs/path/to/file && cat -n /abs/path/to/file | sed -n 'VSTART,VENDp'",
		'',
		'3) Insert new lines BEFORE a given line:',
		"   sed -i 'STARTi\\",
		'NEW_LINE_1',
		'NEW_LINE_2',
		"...",
		"' /abs/path/to/file && cat -n /abs/path/to/file | sed -n 'VSTART,VENDp'",
		'',
		'4) Append new lines at the END of the file:',
		"   sed -i '$a\\",
		'NEW_LINE_1',
		'NEW_LINE_2',
		"...",
		"' /abs/path/to/file && cat -n /abs/path/to/file | sed -n 'VSTART,VENDp'",
		'',
		'Where VSTART and VEND specify a small viewport around the edited region.',
		'',
		'Do NOT emit commands like "3s/print/print()/g" or any other "s/old/new/" style sed substitution; instead,',
		'always rewrite the affected lines using one of the line-based forms above.',
		'',
		'When you are NOT editing files (e.g., running tests, git commands, tools, etc.), you may emit arbitrary bash commands.'
	].join('\n');

	const conversationMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
		{ role: 'system', content: systemPrompt },
		{ role: 'assistant', content: fencedBashBlock(metadataCommand) },
		{ role: 'user', content: formatStdoutBlock(metadataSummary) },
		{ role: 'assistant', content: fencedBashBlock(`cat -n ${filePath}`) },
		{ role: 'user', content: formatStdoutBlock(formatLineNumberedOutput(fullText)) }
	];

	if (viewport.end >= viewport.start) {
		const viewportOutput = formatLineNumberedOutput(fullText, viewport.start, viewport.end);
		conversationMessages.push(
			{ role: 'assistant', content: fencedBashBlock(`cat -n ${filePath} | sed -n '${viewport.start},${viewport.end}p'`) },
			{ role: 'user', content: formatStdoutBlock(viewportOutput) }
		);
	}

	const requestBody: any = {
		model: modelName,
		messages: conversationMessages
	};
	if (!USE_GEMINI) {
		requestBody.temperature = 0.7;
		requestBody.top_p = 0.8;
		requestBody.top_k = 20;
		requestBody.min_p = 0;
		requestBody.extra_body = {
			chat_template_kwargs: {
				enable_thinking: false
			}
		};
	}

	const postData = JSON.stringify(requestBody);
	headers['Content-Length'] = Buffer.byteLength(postData);

	const options: any = {
		hostname,
		port,
		path,
		method: 'POST',
		headers
	};
	if (signal) {
		options.signal = signal;
	}

	const requestModule = useHttps ? https : http;

	const json = await new Promise<any>((resolve, reject) => {
		const req = requestModule.request(options, (res: http.IncomingMessage) => {
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

	const content = extractChatContent(json);
	if (typeof content !== 'string' || content.trim().length === 0) {
		throw new Error('Empty model content');
	}
	const action = parsePlannedAction(content, doc);
	if (!action) {
		throw new Error('No valid action parsed from model output');
	}
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

function parsePlannedAction(raw: string, doc?: vscode.TextDocument): PlannedAction | undefined {
	const command = extractBashCommand(raw);
	if (!command) {
		return undefined;
	}
	const normalized = command.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
	if (!normalized) {
		return undefined;
	}
	// Try to interpret the command as a structured VS Code action derived from the bash transcript.
	if (doc) {
		// 1) Edits encoded as sed -i ... (insert/replace/delete)
		const editAction = parseEditFromSedCommand(normalized, doc);
		if (editAction) {
			return editAction;
		}
		// 2) Viewport / selection moves encoded as cat -n ... | sed -n 'vstart,vendp'
		const viewportAction = parseViewportFromCatCommand(normalized, doc);
		if (viewportAction) {
			return viewportAction;
		}
	}
	// Fallback: execute the raw command in the integrated terminal.
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
function parseEditFromSedCommand(command: string, doc: vscode.TextDocument): PlannedAction | undefined {
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
	// Be conservative: only apply edits when the sed target matches the active document path.
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
		// Unescape single quotes as done in _escape_single_quotes_for_sed.
		payload = payload.replace(/'\"'\"'/g, "'");
		const startLine0 = Math.max(0, startLine1 - 1);
		const endLine0 = Math.max(0, endLine1 - 1);
		const startPos: [number, number] = [startLine0, 0];

		// Replace up to the start of the line after endLine, or end-of-document.
		let endPosLine = endLine0 + 1;
		let endPosChar = 0;
		if (endPosLine >= doc.lineCount) {
			endPosLine = doc.lineCount - 1;
			endPosChar = doc.lineAt(endPosLine).range.end.character;
		}

		// Preserve multi-line payload as-is; append a trailing newline so sed-style replacements map naturally.
		const text = payload.endsWith('\n') ? payload : payload + '\n';
		return {
			kind: 'editReplace',
			range: { start: startPos, end: [endPosLine, endPosChar] },
			text,
		};
	}

	// Insert before a given line: "STARTi\newline<payload...>"
	const insertMatch = script.match(/^(\d+)i\\\n([\s\S]*)$/);
	if (insertMatch) {
		const line1 = Number(insertMatch[1]);
		let payload = insertMatch[2] ?? '';
		if (!Number.isFinite(line1)) {
			return undefined;
		}
		payload = payload.replace(/'\"'\"'/g, "'");
		const insertLine0 = Math.max(0, line1 - 1);
		const position: [number, number] = [insertLine0, 0];
		const text = payload.endsWith('\n') ? payload : payload + '\n';
		return {
			kind: 'editInsert',
			position,
			text,
		};
	}

	// Append at end of file: "$a\newline<payload...>"
	const appendMatch = script.match(/^\$a\\\n([\s\S]*)$/);
	if (appendMatch) {
		let payload = appendMatch[1] ?? '';
		payload = payload.replace(/'\"'\"'/g, "'");
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
function parseViewportFromCatCommand(command: string, doc: vscode.TextDocument): PlannedAction | undefined {
	const main = command.split(/&&|\|\|/)[0]?.trim() ?? '';
	if (!main) {
		return undefined;
	}

	// Simple file-open: cat -n <file>
	const simpleCatMatch = main.match(/^cat\s+-n\s+([^\s|]+)\s*$/);
	if (simpleCatMatch) {
		const targetFile = simpleCatMatch[1] ?? '';
		if (targetFile !== doc.uri.fsPath) {
			return undefined;
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

	if (targetFile !== doc.uri.fsPath) {
		return undefined;
	}

	const startLine1 = Number(startStr);
	const endLine1 = Number(endStr);
	if (!Number.isFinite(startLine1) || !Number.isFinite(endLine1)) {
		return undefined;
	}

	// Place the cursor in the middle of the viewport (1-based to 0-based).
	const center1 = Math.floor((startLine1 + endLine1) / 2);
	const center0 = Math.max(0, center1 - 1);
	const lastLine = Math.max(0, doc.lineCount - 1);
	const line = Math.min(center0, lastLine);
	const endChar = doc.lineAt(line).range.end.character;

	return {
		kind: 'setSelections',
		selections: [
			{
				start: [line, endChar],
				end: [line, endChar],
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