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
		hidePreviewUI();
	});

	const modelRun = vscode.commands.registerCommand('crowd-pilot.modelRun', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		try {
			const plan = await requestModelActions(editor);

			if (!previewVisible) {
				showPreviewUI(plan);
				return;
			}

			const runPlan = currentPlan ?? plan;
			hidePreviewUI();
			await executePlan(runPlan);
			vscode.window.showInformationMessage('All actions emitted');
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

	context.subscriptions.push(hideUi, sglangTest, modelRun);
}

export function deactivate() {}

// -------------------- Plan Types & Execution --------------------
type PlannedAction =
| { kind: 'showTextDocument' }
| { kind: 'setSelections', selections: Array<{ start: [number, number], end: [number, number] }> }
| { kind: 'editInsert', position: [number, number], text: string }
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
let previewQuickPick: vscode.QuickPick<(vscode.QuickPickItem & { index: number })> | undefined;

function showPreviewUI(plan: PlannedAction[]): void {
	const items: (vscode.QuickPickItem & { index: number })[] = plan.map((action, index) => {
		switch (action.kind) {
			case 'showTextDocument':
				return { index, label: '$(file) Focus active text document' };
			case 'setSelections':
				{
					const cursors = action.selections.map(s => `(${s.start[0]}, ${s.start[1]})`).join(', ');
					return { index, label: `$(cursor) Move cursor to ${cursors}` };
				}
			case 'editInsert':
				return { index, label: `$(pencil) Insert "${action.text.replace(/\n/g, '\\n')}" at (${action.position[0]}, ${action.position[1]})` };
			case 'terminalShow':
				return { index, label: '$(terminal) Focus terminal' };
			case 'terminalSendText':
				return { index, label: `$(terminal) Run "${action.text}" in terminal` };
		}
	});
    if (!previewQuickPick) {
        previewQuickPick = vscode.window.createQuickPick<(vscode.QuickPickItem & { index: number })>();
		previewQuickPick.title = 'crowd-pilot: preview';
		previewQuickPick.matchOnDetail = true;
		previewQuickPick.ignoreFocusOut = true;
		previewQuickPick.canSelectMany = false;
        previewQuickPick.onDidAccept(async () => {
            const qp = previewQuickPick!;
            const selected = qp.selectedItems?.[0];
            qp.hide();
            if (selected) {
                await executePlan([plan[selected.index]]);
                vscode.window.showInformationMessage('Action executed');
            }
        });
		previewQuickPick.onDidHide(() => {
			previewVisible = false;
			vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
			try { previewQuickPick?.dispose(); } catch {}
			previewQuickPick = undefined;
		});
	}
	previewQuickPick.items = items;
	previewQuickPick.placeholder = 'Press Tab to run all, Enter for selected, or Esc to hide';
	previewQuickPick.show();
	previewVisible = true;
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, true);
	currentPlan = plan;
}

function hidePreviewUI(): void {
	if (previewQuickPick) {
		try { previewQuickPick.hide(); } catch {}
		return;
	}
	previewVisible = false;
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
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
