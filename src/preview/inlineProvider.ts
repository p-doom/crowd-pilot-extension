import * as vscode from 'vscode';
import { Action, toVscodePosition } from './types';

/**
 * Provides inline completion items (ghost text) for code edit actions.
 * This takes priority over Cursor's hints and works on empty lines.
 */
export class CrowdPilotInlineProvider implements vscode.InlineCompletionItemProvider {
    private action: Action | null = null;
    private enabled: boolean = true;

    /**
     * Set the current action to display as inline completion.
     */
    setAction(action: Action): void {
        this.action = action;
        // Trigger VS Code to re-query inline completions
        vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }

    /**
     * Clear the current action.
     */
    clearAction(): void {
        this.action = null;
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
        if (!this.enabled || !this.action) {
            return [];
        }

        // Only handle pure insertions (not replacements)
        // Replacements are handled by decorations to properly show what's being deleted
        if (this.action.kind !== 'editInsert') {
            return [];
        }

        const insertPos = toVscodePosition(this.action.position);
        
        // Only provide completion if insert position is at or after the cursor
        // VS Code's inline completion API shows ghost text at/after cursor position
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

