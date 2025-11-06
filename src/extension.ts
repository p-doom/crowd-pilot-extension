// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "crowd-pilot" is now active!');

	// Configure terminal to allow tab keybinding to work
	// This makes the command skip the shell so VS Code can intercept tab in terminals
	const config = vscode.workspace.getConfiguration('terminal.integrated');
	const commandsToSkipShell = config.get<string[]>('commandsToSkipShell', []);
	if (!commandsToSkipShell.includes('crowd-pilot.testRun')) {
		commandsToSkipShell.push('crowd-pilot.testRun');
		config.update('commandsToSkipShell', commandsToSkipShell, vscode.ConfigurationTarget.Global);
	}

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('crowd-pilot.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from crowd-pilot-extension!');
	});

	context.subscriptions.push(disposable);
	const testRun = vscode.commands.registerCommand('crowd-pilot.testRun', async () => {
		const editor = vscode.window.activeTextEditor;
		const doc = editor!.document;
		const term = vscode.window.terminals[0] ?? vscode.window.createTerminal('Test');
		const git = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1);
		const repo = git?.repositories?.[0];
	
		// Emit a few actions:
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

// This method is called when your extension is deactivated
export function deactivate() {}
