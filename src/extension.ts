import * as vscode from 'vscode';

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
		if (!commandsToSkipShell.includes('crowd-pilot.hideUi')) {
			commandsToSkipShell.push('crowd-pilot.hideUi');
			updated = true;
		}
		if (updated) {
			await config.update('commandsToSkipShell', commandsToSkipShell, vscode.ConfigurationTarget.Global);
		}
		// Prime terminal subsystem after intercept is enabled (NOTE: this is a workaround)
		await primeTerminalSubsystem();
	})().catch((err) => console.error('[crowd-pilot] Startup initialization error:', err));

	const testRun = vscode.commands.registerCommand('crowd-pilot.testRun', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const doc = editor.document;
		const term = vscode.window.terminals[0] ?? vscode.window.createTerminal('Test');
		const plan = buildTestRunPlan(editor, doc, term);

		if (!previewVisible) {
			showPreviewUI(plan);
			return;
		}

		const runPlan = currentPlan ?? plan;
		hidePreviewUI();

		await executePlan(runPlan);
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
		const t = vscode.window.createTerminal('crowd-pilot prime');
		await Promise.race([
			opened,
			new Promise<void>(r => setTimeout(r, 150))
		]);
		try { t.dispose(); } catch {}
		await new Promise<void>(r => setTimeout(r, 50));
		console.log('[crowd-pilot] Primed terminal subsystem');
	} catch (err) {
		console.error('[crowd-pilot] Failed to prime terminal subsystem:', err);
	}
}

// -------------------- Plan Types & Execution --------------------
type PlannedAction =
| { kind: 'showTextDocument' }
| { kind: 'setSelections', selections: Array<{ start: [number, number], end: [number, number] }> }
| { kind: 'editInsert', position: [number, number], text: string }
| { kind: 'terminalShow' }
| { kind: 'terminalSendText', text: string };

let currentPlan: PlannedAction[] | undefined;

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
let previewVisible = false;
let previewQuickPick: vscode.QuickPick<(vscode.QuickPickItem & { index: number })> | undefined;

function showPreviewUI(plan: PlannedAction[]): void {
	const items: (vscode.QuickPickItem & { index: number })[] = plan.map((action, index) => {
		switch (action.kind) {
			case 'showTextDocument':
				return { index, label: '$(file) Focus active text document' };
			case 'setSelections':
				return { index, label: '$(cursor) Move cursor to selection(s)' };
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
