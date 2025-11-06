import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	console.log('[Crowd Pilot] Extension activated');

	// Configure terminal to allow tab keybinding to work
	(async () => {
		const config = vscode.workspace.getConfiguration('terminal.integrated');
		const commandsToSkipShell = config.get<string[]>('commandsToSkipShell', []);
		let updated = false;
		if (!commandsToSkipShell.includes('crowd-pilot.testRun')) {
			commandsToSkipShell.push('crowd-pilot.testRun');
			updated = true;
		}
		if (!commandsToSkipShell.includes('crowd-pilot.hideUi')) {
			commandsToSkipShell.push('crowd-pilot.hideUi');
			updated = true;
		}
		if (updated) {
			await config.update('commandsToSkipShell', commandsToSkipShell, vscode.ConfigurationTarget.Global);
		}
		// Prime terminal subsystem after intercept is enabled (NOTE: this is a workaround)
		await primeTerminalSubsystem();
	})().catch((err) => console.error('[Crowd Pilot] Startup initialization error:', err));

	const testRun = vscode.commands.registerCommand('crowd-pilot.testRun', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const doc = editor.document;
		const term = vscode.window.terminals[0] ?? vscode.window.createTerminal('Test');
		const plan = buildTestRunPlan(editor, doc, term);

		if (!uiPanel) {
			showPreviewUI(plan);
			return;
		}

		hidePreviewUI();

		await executePlan(plan);
		vscode.window.showInformationMessage('All actions emitted');
	  });

	const hideUi = vscode.commands.registerCommand('crowd-pilot.hideUi', () => {
		hidePreviewUI();
	});

	context.subscriptions.push(testRun, hideUi);
}

export function deactivate() {}

async function primeTerminalSubsystem(): Promise<void> {
	try {
		if (vscode.window.terminals.length > 0) {
			return;
		}
		const opened = new Promise<void>((resolve) => {
			const d = vscode.window.onDidOpenTerminal(() => {
				try { d.dispose(); } catch {}
				resolve();
			});
		});
		const t = vscode.window.createTerminal('Crowd Pilot Prime');
		await Promise.race([
			opened,
			new Promise<void>(r => setTimeout(r, 150))
		]);
		try { t.dispose(); } catch {}
		await new Promise<void>(r => setTimeout(r, 50));
		console.log('[Crowd Pilot] Primed terminal subsystem');
	} catch (err) {
		console.error('[Crowd Pilot] Failed to prime terminal subsystem:', err);
	}
}

// -------------------- Plan Types & Execution --------------------
type PlannedAction =
| { kind: 'showTextDocument' }
| { kind: 'setSelections', selections: Array<{ start: [number, number], end: [number, number] }> }
| { kind: 'editInsert', position: [number, number], text: string }
| { kind: 'terminalShow' }
| { kind: 'terminalSendText', text: string };

function buildTestRunPlan(_editor: vscode.TextEditor, _doc: vscode.TextDocument, _term: vscode.Terminal): PlannedAction[] {
	const plan: PlannedAction[] = [];
	plan.push({ kind: 'showTextDocument' });
	plan.push({ kind: 'setSelections', selections: [{ start: [0, 0], end: [0, 0] }] });
	plan.push({ kind: 'editInsert', position: [0, 0], text: 'hello world\n' });
	plan.push({ kind: 'terminalShow' });
	plan.push({ kind: 'terminalSendText', text: 'echo VSCode test' });
	return plan;
}

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
			await editor.edit(e => e.insert(new vscode.Position(action.position[0], action.position[1]), action.text));
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
let uiPanel: vscode.WebviewPanel | undefined;

function showPreviewUI(plan: PlannedAction[]): void {
	if (uiPanel) {
		try {
			uiPanel.reveal(undefined, true /* preserveFocus */);
		} catch {}
		uiPanel.webview.html = getPreviewHtml(plan);
		return;
	}
	uiPanel = vscode.window.createWebviewPanel(
		'crowdPilotPreview',
		'Crowd Pilot Preview',
		{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
		{ enableScripts: false, retainContextWhenHidden: false }
	);
	uiPanel.webview.html = getPreviewHtml(plan);
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, true);
	uiPanel.onDidDispose(() => {
		uiPanel = undefined;
		vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
	});
}

function hidePreviewUI(): void {
	if (!uiPanel) {
		vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
		return;
	}
	try { uiPanel.dispose(); } catch {}
	uiPanel = undefined;
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
}

function getPreviewHtml(plan: PlannedAction[]): string {
const items = plan.map(action => {
	switch (action.kind) {
		case 'showTextDocument':
			return '<li>Focus the active text document</li>';
		case 'setSelections':
			return '<li>Move cursor to requested selection(s)</li>';
		case 'editInsert':
			return `<li>Insert <code>${escapeHtml(action.text)}</code> at (${action.position[0]}, ${action.position[1]})</li>`;
		case 'terminalShow':
			return '<li>Focus the terminal</li>';
		case 'terminalSendText':
			return `<li>Run <code>${escapeHtml(action.text)}</code> in the terminal</li>`;
		default:
			return '';
	}
}).join('');
return `<!DOCTYPE html>
	<html>
	<head>
		<meta charset="UTF-8" />
		<style>
		body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0}
		.container{padding:12px}
		h1{font-size:14px;margin:0 0 8px}
		p{margin:0 0 8px}
		ul{margin:0 0 8px 18px}
		code{font-family:var(--vscode-editor-font-family);background:var(--vscode-editor-inactiveSelectionBackground);padding:1px 3px;border-radius:3px}
		.hint{opacity:.8}
		</style>
	</head>
	<body>
		<div class="container">
			<h1>Upcoming actions</h1>
			<p>This step will perform the following changes:</p>
			<ul>${items}</ul>
			<p class="hint">Press <code>Tab</code> again to run, or <code>Esc</code> to hide.</p>
		</div>
	</body>
	</html>`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
