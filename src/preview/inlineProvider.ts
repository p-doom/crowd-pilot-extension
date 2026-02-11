import * as vscode from 'vscode';
import { Action, toVscodePosition } from './types';

/**
 * Data needed to show inline ghost text for replacements.
 */
export interface InlineReplaceData {
	/** Position where ghost text should appear */
	position: vscode.Position;
	/** The new text to show as ghost text */
	text: string;
}

/**
 * Provides inline completion items (ghost text) for code edit actions.
 * This takes priority over Cursor's hints and works on empty lines.
 */
export class CrowdPilotInlineProvider implements vscode.InlineCompletionItemProvider {
	private action: Action | null = null;
	private inlineReplaceData: InlineReplaceData | null = null;
	private enabled: boolean = true;

    /**
     * Set the current action to display as inline completion.
     */
	setAction(action: Action): void {
		this.action = action;
		this.inlineReplaceData = null;
		// Trigger VS Code to re-query inline completions
		vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
	}

	/**
	 * Set inline replacement data for editReplace actions.
	 * This shows the new text as multi-line ghost text.
	 */
	setInlineReplace(data: InlineReplaceData): void {
		this.inlineReplaceData = data;
		this.action = null;
		vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
	}

    /**
     * Clear the current action.
     */
	clearAction(): void {
		this.action = null;
		this.inlineReplaceData = null;
	}

    /**
     * Get the current action.
     */
    getAction(): Action | null {
        return this.action;
    }

    /**
     * Enable or disable the provider.
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    /**
     * Provide inline completion items.
     */
    provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
	): vscode.ProviderResult<vscode.InlineCompletionList | vscode.InlineCompletionItem[]> {
		if (!this.enabled) {
			return [];
		}

		// Handle inline replace data first.
		if (this.inlineReplaceData) {
			const item = new vscode.InlineCompletionItem(
				this.inlineReplaceData.text,
				new vscode.Range(this.inlineReplaceData.position, this.inlineReplaceData.position)
			);
			return [item];
		}

		if (!this.action || this.action.kind !== 'editInsert') {
			return [];
		}

		const insertPos = toVscodePosition(this.action.position);
		if (insertPos.isBefore(position)) {
			return [];
		}
		
		const item = new vscode.InlineCompletionItem(
			this.action.text,
            new vscode.Range(insertPos, insertPos)
        );
        
        return [item];
    }
}
