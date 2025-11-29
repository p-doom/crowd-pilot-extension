import * as vscode from 'vscode';
import * as http from 'http';
import { Buffer } from 'buffer';

const HOSTNAME = 'hai005';
const PORT = 30000;

export function activate(context: vscode.ExtensionContext) {

	console.log('[crowd-pilot] Extension activated');

	// Configure terminal to allow tab keybinding to work
	(async () => {
		const config = vscode.workspace.getConfiguration('terminal.integrated');
		const commandsToSkipShell = config.get<string[]>('commandsToSkipShell', []);
		let updated = false;
		if (!commandsToSkipShell.includes('crowd-pilot.testRun')) {
			commandsToSkipShell.push('crowd-pilot.testRun');
			updated = true;
		}
		if (!commandsToSkipShell.includes('crowd-pilot.previewNoop')) {
			commandsToSkipShell.push('crowd-pilot.previewNoop');
			updated = true;
		}
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
			const action = currentPlan?.[0] ?? getHardcodedNextAction(editor);
			if (!action) {
				hidePreviewUI();
				return;
			}
			hidePreviewUI(false);
			await executePlan([action]);
			advanceMockStep();
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

	const previewNoop = vscode.commands.registerCommand('crowd-pilot.previewNoop', () => {});

	const testRun = vscode.commands.registerCommand('crowd-pilot.testRun', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		try {
			const plan = buildMockPlan(editor);
			if (!previewVisible) {
				showPreviewUI(plan);
				return;
			}
			const runPlan = currentPlan ?? plan;
			hidePreviewUI();
			await executePlan(runPlan);
			vscode.window.showInformationMessage('All actions emitted (mock)');
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Mock run failed: ${errorMessage}`);
		}
	});

	// Auto-preview listeners
	const onSelChange = vscode.window.onDidChangeTextEditorSelection((e) => {
		if (e.textEditor === vscode.window.activeTextEditor) {
			suppressAutoPreview = false;
			autoShowNextAction();
		}
	});
	const onActiveChange = vscode.window.onDidChangeActiveTextEditor(() => {
		suppressAutoPreview = false;
		autoShowNextAction();
	});
	const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
		if (vscode.window.activeTextEditor?.document === e.document) {
			suppressAutoPreview = false;
			autoShowNextAction();
		}
	});

	context.subscriptions.push(hideUi, sglangTest, modelRun, testRun, previewNoop, onSelChange, onActiveChange, onDocChange);
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

let currentPlan: PlannedAction[] | undefined;

async function executePlan(plan: PlannedAction[]): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	const doc = editor.document;
	const term = vscode.window.terminals[0] ?? vscode.window.createTerminal('Test');
	for (const action of plan) {
		if (action.kind === 'showTextDocument') {
			await vscode.window.showTextDocument(doc);
			continue;
		}
		if (action.kind === 'setSelections') {
			editor.selections = action.selections.map(s => new vscode.Selection(
				new vscode.Position(s.start[0], s.start[1]),
				new vscode.Position(s.end[0], s.end[1])
			));
			continue;
		}
		if (action.kind === 'editInsert') {
			await editor.edit((e: vscode.TextEditorEdit) => e.insert(new vscode.Position(action.position[0], action.position[1]), action.text));
			continue;
		}
		if (action.kind === 'editDelete') {
			const range = new vscode.Range(
				new vscode.Position(action.range.start[0], action.range.start[1]),
				new vscode.Position(action.range.end[0], action.range.end[1])
			);
			await editor.edit((e: vscode.TextEditorEdit) => e.delete(range));
			continue;
		}
		if (action.kind === 'editReplace') {
			const range = new vscode.Range(
				new vscode.Position(action.range.start[0], action.range.start[1]),
				new vscode.Position(action.range.end[0], action.range.end[1])
			);
			await editor.edit((e: vscode.TextEditorEdit) => e.replace(range, action.text));
			continue;
		}
		if (action.kind === 'terminalShow') {
			term.show();
			continue;
		}
		if (action.kind === 'terminalSendText') {
			term.sendText(action.text);
			continue;
		}
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

function disposePreviewDecorations() {
	try { decorationDeleteType?.dispose(); } catch {}
	try { decorationReplaceType?.dispose(); } catch {}
	try { decorationReplaceBlockType?.dispose(); } catch {}
	decorationDeleteType = undefined;
	decorationReplaceType = undefined;
	decorationReplaceBlockType = undefined;
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

function showPreviewUI(plan: PlannedAction[]): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	disposePreviewDecorations();

	// Only preview the next text edit action (insert/delete/replace/terminalSendText/setSelections)
	const next = plan.find(a => a.kind === 'editInsert' || a.kind === 'editDelete' || a.kind === 'editReplace' || a.kind === 'terminalSendText' || a.kind === 'setSelections');
	if (!next) {
		previewVisible = false;
		vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
		currentPlan = plan;
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
		const margin = getDynamicMargin(editor, targetPos.line, "↳ Move Cursor Here");

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "↳ Move Cursor Here"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top;`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(targetPos, targetPos) }]);
	} else if (next.kind === 'terminalSendText') {
		const cursor = editor.selection.active;
		const cmd = next.text.replace(/"/g, '\\"').replace(/\r?\n/g, '\\A ');
		const margin = getDynamicMargin(editor, cursor.line, "↳ Execute in Terminal:\n" + next.text);

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "↳ Execute in Terminal:\\A ${cmd}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top;`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(cursor, cursor) }]);
	} else if (next.kind === 'editInsert') {
		const posLine = next.position[0];
		const fullBlock = next.text;
		const cssContent = fullBlock
			.replace(/"/g, '\\"')
			.replace(/\r?\n/g, '\\A ');

		// "Next to" logic:
		// If inserting at line N > 0, we attach 'after' to line N-1.
		// If inserting at line 0, we attach 'after' to line 0 (best effort).
		const anchorLine = posLine > 0 ? posLine - 1 : 0;
		const anchorPos = new vscode.Position(anchorLine, Number.MAX_VALUE); // End of anchor line
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
	currentPlan = plan;
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

function autoShowNextAction(): void {
	if (suppressAutoPreview) { return; }
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	const next = getHardcodedNextAction(editor);
	if (next) {
		showPreviewUI([next]);
	} else {
		hidePreviewUI();
	}
}

// -------------------- SGLang Client (simple test) --------------------
async function callSGLangChat(): Promise<void> {
	const requestBody = {
		model: 'qwen/qwen2.5-0.5b-instruct',
		messages: [
			{ role: 'user', content: 'What is the capital of France?' }
		]
	};
	const postData = JSON.stringify(requestBody);

	const options = {
		hostname: HOSTNAME,
		port: PORT,
		path: '/v1/chat/completions',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(postData)
		}
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

		vscode.window.showInformationMessage(`SGLang response: ${JSON.stringify(json, null, 2)}`);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`SGLang request failed: ${errorMessage}`);
	}
}

// -------------------- Model-planned Actions --------------------
async function requestModelActions(editor: vscode.TextEditor): Promise<PlannedAction[]> {
	const schemaDescription = [
		'Role: You suggest the next VS Code editor/terminal action to progress the current task.',
		'Output ONLY a JSON array (no prose, no code fences). Length exactly 1.',
		'Coordinates are zero-based [line, column].',
		'Allowed actions (JSON schema-like):',
		'{ kind: "showTextDocument" }',
		'{ kind: "setSelections", selections: Array<{ start: [number, number], end: [number, number] }> }',
		'{ kind: "editInsert", position: [number, number], text: string }',
		'{ kind: "editDelete", range: { start: [number, number], end: [number, number] } }',
		'{ kind: "editReplace", range: { start: [number, number], end: [number, number] }, text: string }',
		'{ kind: "terminalShow" }',
		'{ kind: "terminalSendText", text: string }',
		'Guidelines:',
		'- If you you insert text, insert until the logical end of the current statement or block.',
		'- When inserting text, make sure to not repeat existing text (except when replacing existing text).',
		'- Use double-quoted JSON strings.'
	].join('\n');

	const doc = editor.document;
	const cursor = editor.selection.active;
	const contextRange = new vscode.Range(new vscode.Position(0, 0), cursor);
	const contextCode = doc.getText(contextRange);
	const maxContextChars = 20000;
	const allLines = contextCode.split(/\r?\n/);
	let startLineIndex = 0;
	let visibleLines = allLines;
	if (contextCode.length > maxContextChars) {
		let acc = 0;
		let idx = allLines.length;
		while (idx > 0 && acc <= maxContextChars) {
			idx--;
			acc += allLines[idx].length + 1;
		}
		startLineIndex = idx;
		visibleLines = allLines.slice(idx);
	}
	const numberedContext = visibleLines.map((line, i) => `${startLineIndex + i}: ${line}`).join('\n');

	const tabbingPrompt = [
		'Your role: Propose the single next action according to the schema to help the developer progress.',
		'',
		'Available context:',
		`- File: ${doc.fileName}`,
		`- Language: ${doc.languageId}`,
		`- Cursor: (${cursor.line}, ${cursor.character})`,
		'',
		'Current file content up to the cursor (zero-based line numbers):',
		'```',
		numberedContext,
		'```',
		'',
		'Respond with ONLY a JSON array containing exactly one action.'
	].join('\n');

	const requestBody = {
		model: 'qwen/qwen2.5-0.5b-instruct',
		messages: [
			{ role: 'system', content: schemaDescription },
			{ role: 'user', content: tabbingPrompt }
		]
	};

	const postData = JSON.stringify(requestBody);
	const options = {
		hostname: HOSTNAME,
		port: PORT,
		path: '/v1/chat/completions',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(postData)
		}
	};

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

	const content = extractChatContent(json);
	if (typeof content !== 'string' || content.trim().length === 0) {
		throw new Error('Empty model content');
	}
	const actions = parsePlannedActions(content);
	if (actions.length === 0) {
		throw new Error('No valid actions parsed from model output');
	}
	return actions;
}

// -------------------- Mock Actions (offline/local debug) --------------------
function buildMockPlan(editor: vscode.TextEditor): PlannedAction[] {
	const cursor = editor.selection.active;
	const insertPosition: [number, number] = [cursor.line, cursor.character];
	const selections = [
		{ start: [cursor.line, cursor.character] as [number, number], end: [cursor.line, cursor.character] as [number, number] }
	];
	return [
		{ kind: 'showTextDocument' },
		{ kind: 'setSelections', selections },
		{ kind: 'editInsert', position: insertPosition, text: '// crowd-pilot mock insert\n' },
		{ kind: 'terminalShow' },
		{ kind: 'terminalSendText', text: 'echo "[crowd-pilot] mock run"' }
	];
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

function parsePlannedActions(raw: string): PlannedAction[] {
	let text = raw.trim();
	text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
	const arrayMatch = text.match(/\[[\s\S]*\]/);
	const jsonText = arrayMatch ? arrayMatch[0] : text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		return [];
	}
	if (!Array.isArray(parsed)) { return []; }
	const result: PlannedAction[] = [];
	for (const item of parsed) {
		if (!item || typeof item !== 'object' || typeof (item as any).kind !== 'string') { continue; }
		switch ((item as any).kind) {
			case 'showTextDocument':
				result.push({ kind: 'showTextDocument' });
				break;
			case 'setSelections': {
				const selections = Array.isArray((item as any).selections) ? (item as any).selections : [];
				const norm = selections.map((s: any) => ({
					start: Array.isArray(s?.start) && s.start.length === 2 ? [Number(s.start[0]) || 0, Number(s.start[1]) || 0] as [number, number] : [0, 0] as [number, number],
					end: Array.isArray(s?.end) && s.end.length === 2 ? [Number(s.end[0]) || 0, Number(s.end[1]) || 0] as [number, number] : [0, 0] as [number, number]
				}));
				result.push({ kind: 'setSelections', selections: norm });
				break;
			}
			case 'editInsert': {
				const pos = Array.isArray((item as any).position) && (item as any).position.length === 2 ? [Number((item as any).position[0]) || 0, Number((item as any).position[1]) || 0] as [number, number] : [0, 0] as [number, number];
				const text = typeof (item as any).text === 'string' ? (item as any).text : '';
				result.push({ kind: 'editInsert', position: pos, text });
				break;
			}
			case 'editDelete': {
				const start = Array.isArray((item as any).range?.start) && (item as any).range.start.length === 2 ? [Number((item as any).range.start[0]) || 0, Number((item as any).range.start[1]) || 0] as [number, number] : [0, 0] as [number, number];
				const end = Array.isArray((item as any).range?.end) && (item as any).range.end.length === 2 ? [Number((item as any).range.end[0]) || 0, Number((item as any).range.end[1]) || 0] as [number, number] : [0, 0] as [number, number];
				result.push({ kind: 'editDelete', range: { start, end } });
				break;
			}
			case 'editReplace': {
				const start = Array.isArray((item as any).range?.start) && (item as any).range.start.length === 2 ? [Number((item as any).range.start[0]) || 0, Number((item as any).range.start[1]) || 0] as [number, number] : [0, 0] as [number, number];
				const end = Array.isArray((item as any).range?.end) && (item as any).range.end.length === 2 ? [Number((item as any).range.end[0]) || 0, Number((item as any).range.end[1]) || 0] as [number, number] : [0, 0] as [number, number];
				const text = typeof (item as any).text === 'string' ? (item as any).text : '';
				result.push({ kind: 'editReplace', range: { start, end }, text });
				break;
			}
			case 'terminalShow':
				result.push({ kind: 'terminalShow' });
				break;
			case 'terminalSendText': {
				const text = typeof (item as any).text === 'string' ? (item as any).text : '';
				result.push({ kind: 'terminalSendText', text });
				break;
			}
			default:
				break;
		}
	}
	return result;
}
