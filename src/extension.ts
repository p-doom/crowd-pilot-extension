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
let decorationInsertType: vscode.TextEditorDecorationType | undefined;
let decorationDeleteType: vscode.TextEditorDecorationType | undefined;
let decorationReplaceType: vscode.TextEditorDecorationType | undefined;
let decorationReplaceBlockType: vscode.TextEditorDecorationType | undefined;
let mockStep = 0;
let suppressAutoPreview = false;

function disposePreviewDecorations() {
	try { decorationInsertType?.dispose(); } catch {}
	try { decorationDeleteType?.dispose(); } catch {}
	try { decorationReplaceType?.dispose(); } catch {}
	try { decorationReplaceBlockType?.dispose(); } catch {}
	decorationInsertType = undefined;
	decorationDeleteType = undefined;
	decorationReplaceType = undefined;
	decorationReplaceBlockType = undefined;
}

function showPreviewUI(plan: PlannedAction[]): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	disposePreviewDecorations();

	// Only preview the next text edit action (insert/delete/replace)
	const next = plan.find(a => a.kind === 'editInsert' || a.kind === 'editDelete' || a.kind === 'editReplace');
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

	if (next.kind === 'editInsert') {
		const pos = new vscode.Position(next.position[0], next.position[1]);
		decorationInsertType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: `${trimText(next.text)}`,
				color: new vscode.ThemeColor('charts.purple'),
				fontStyle: 'italic',
				fontWeight: '600',
			}
		});
		editor.setDecorations(decorationInsertType, [{ range: new vscode.Range(pos, pos) }]);
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

		// Show replacement block on the line after the replaced range
		const lines = next.text.split(/\r?\n/);
		const oneLineBlock = next.text.replace(/\r?\n/g, ' ⏎ ');
		
		// Determine target for the "lines after" decoration
		const docLineCount = editor.document.lineCount;
		const endLine = range.end.line;
		
		if (endLine + 1 < docLineCount) {
			// Attach 'before' decoration to the start of the NEXT line
			const nextLineStart = new vscode.Position(endLine + 1, 0);
			decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
				before: {
					contentText: `↳ [Replacement]: ${oneLineBlock}`,
					color: new vscode.ThemeColor('charts.purple'),
					fontStyle: 'italic',
					fontWeight: '600',
					backgroundColor: 'rgba(100, 0, 100, 0.15)',
					margin: '0 0 0 20px',
					textDecoration: 'none; display: block;' // Attempt to force block display
				}
			});
			editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(nextLineStart, nextLineStart) }]);
		} else {
			// EOF: Attach 'after' decoration to the end of the current line
			decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
				after: {
					contentText: `  ↳ [Replacement]: ${oneLineBlock}`,
					color: new vscode.ThemeColor('charts.purple'),
					fontStyle: 'italic',
					fontWeight: '600',
					backgroundColor: 'rgba(100, 0, 100, 0.15)',
					margin: '0 0 0 20px'
				}
			});
			editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(range.end, range.end) }]);
		}
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
		const endChar = doc.lineAt(endLine).range.end.character;
		const range = {
			start: [startLine, 0] as [number, number],
			end: [endLine, endChar] as [number, number]
		};
		return { kind: 'editDelete', range };
	}
	return undefined;
}

function advanceMockStep(): void {
	mockStep = (mockStep + 1) % 3;
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
