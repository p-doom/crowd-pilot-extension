import * as vscode from 'vscode';
import { Action } from './types';

/**
 * Provides hover tooltips for meta-action indicators.
 * Shows full content when hovering over truncated terminal commands, etc.
 */
export class MetaActionHoverProvider implements vscode.HoverProvider {
    private action: Action | null = null;
    private anchorLine: number | null = null;

    /**
     * Set the current action and its anchor line for hover detection.
     */
    setAction(action: Action, anchorLine: number): void {
        this.action = action;
        this.anchorLine = anchorLine;
    }

    /**
     * Clear the current action.
     */
    clearAction(): void {
        this.action = null;
        this.anchorLine = null;
    }

    /**
     * Provide hover content when user hovers over the indicator area.
     */
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        if (!this.action || this.anchorLine === null) {
            return null;
        }

        // Check if hovering on the anchor line
        if (position.line !== this.anchorLine) {
            return null;
        }

        // Check if hovering past the line content (in the decoration area)
        const lineLength = document.lineAt(position.line).text.length;
        if (position.character < lineLength) {
            return null;
        }

        // Build hover content based on action type
        const content = this.buildHoverContent();
        if (!content) {
            return null;
        }

        return new vscode.Hover(content);
    }

    /**
     * Build markdown content for the hover based on action type.
     */
    private buildHoverContent(): vscode.MarkdownString | null {
        if (!this.action) {
            return null;
        }

        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        switch (this.action.kind) {
            case 'terminalSendText':
                md.appendMarkdown('**Terminal Command**\n\n');
                md.appendCodeblock(this.action.text, 'bash');
                md.appendMarkdown('\n\n*Press Tab to execute, Esc to dismiss*');
                return md;

            case 'openFile':
                md.appendMarkdown('**Open File**\n\n');
                md.appendMarkdown(`\`${this.action.filePath}\``);
                if (this.action.selections?.[0]) {
                    const line = this.action.selections[0].start[0] + 1;
                    md.appendMarkdown(` at line ${line}`);
                }
                md.appendMarkdown('\n\n*Press Tab to open, Esc to dismiss*');
                return md;

            case 'setSelections':
                const targetLine = this.action.selections[0].start[0] + 1;
                md.appendMarkdown('**Move Cursor**\n\n');
                md.appendMarkdown(`Go to line ${targetLine}`);
                md.appendMarkdown('\n\n*Press Tab to move, Esc to dismiss*');
                return md;

            case 'editInsert':
                md.appendMarkdown('**Insert Text**\n\n');
                md.appendCodeblock(this.action.text, 'plaintext');
                md.appendMarkdown('\n\n*Press Tab to insert, Esc to dismiss*');
                return md;

            case 'editReplace':
                md.appendMarkdown('**Replace Text**\n\n');
                md.appendCodeblock(this.action.text, 'plaintext');
                md.appendMarkdown('\n\n*Press Tab to replace, Esc to dismiss*');
                return md;

            case 'editDelete':
                const startLine = this.action.range.start[0] + 1;
                const endLine = this.action.range.end[0] + 1;
                md.appendMarkdown('**Delete Text**\n\n');
                md.appendMarkdown(`Lines ${startLine}–${endLine}`);
                md.appendMarkdown('\n\n*Press Tab to delete, Esc to dismiss*');
                return md;

            default:
                return null;
        }
    }
}



