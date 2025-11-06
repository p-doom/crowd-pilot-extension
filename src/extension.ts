import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	console.log('[Crowd Pilot] Extension activated');

	// Configure terminal to allow tab keybinding to work
	(async () => {
		const config = vscode.workspace.getConfiguration('terminal.integrated');
		const commandsToSkipShell = config.get<string[]>('commandsToSkipShell', []);
		if (!commandsToSkipShell.includes('crowd-pilot.testRun')) {
			commandsToSkipShell.push('crowd-pilot.testRun');
			await config.update('commandsToSkipShell', commandsToSkipShell, vscode.ConfigurationTarget.Global);
		}
		// Prime terminal subsystem after intercept is enabled (NOTE: this is a workaround)
		await primeTerminalSubsystem();
	})().catch((err) => console.error('[Crowd Pilot] Startup initialization error:', err));

	const testRun = vscode.commands.registerCommand('crowd-pilot.testRun', async () => {
		const editor = vscode.window.activeTextEditor;
		const doc = editor!.document;
		const term = vscode.window.terminals[0] ?? vscode.window.createTerminal('Test');
		const git = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1);
		const repo = git?.repositories?.[0];
	
		await vscode.window.showTextDocument(doc);
		editor!.selections = [new vscode.Selection(0, 0, 0, 0)];
		await editor!.edit(e => e.insert(new vscode.Position(0, 0), 'hello world\n'));
		term.show();
		term.sendText('echo VSCode test');
		//await repo?.pull();
	
		vscode.window.showInformationMessage('All actions emitted');
	  });

	context.subscriptions.push(testRun);
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
