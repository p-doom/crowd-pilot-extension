import * as vscode from 'vscode';
import { Action, toVscodeRange, toVscodePosition, truncate } from './types';
import { DecorationPool, COLORS } from './decorations';
import { CrowdPilotInlineProvider } from './inlineProvider';
import { MetaActionHoverProvider } from './hoverProvider';
import { showPendingActionQuickPick, QuickPickResult } from './quickPick';
import { computeDeletionRanges, hasInsertions, analyzeCoherentReplacement, analyzePureInsertion } from '../utils/diff';

// Re-export types
export { Action, toVscodeRange, toVscodePosition, truncate } from './types';
export { QuickPickResult } from './quickPick';

/**
 * Manages the preview UI for suggested actions.
 * Single entry point for all preview rendering.
 */
export class PreviewManager {
    private decorationPool: DecorationPool;
    private inlineProvider: CrowdPilotInlineProvider;
    private hoverProvider: MetaActionHoverProvider;
    private hoverProviderDisposable: vscode.Disposable | null = null;
    private currentAction: Action | null = null;
    private visible: boolean = false;

    constructor() {
        this.decorationPool = new DecorationPool();
        this.inlineProvider = new CrowdPilotInlineProvider();
        this.hoverProvider = new MetaActionHoverProvider();
    }

    /**
     * Register all providers with VS Code.
     * Call this during extension activation.
     */
    register(context: vscode.ExtensionContext): void {
        // Register inline completion provider for all files
        context.subscriptions.push(
            vscode.languages.registerInlineCompletionItemProvider(
                { pattern: '**' },
                this.inlineProvider
            )
        );

        // Register hover provider for all files
        this.hoverProviderDisposable = vscode.languages.registerHoverProvider(
            { pattern: '**' },
            this.hoverProvider
        );
        context.subscriptions.push(this.hoverProviderDisposable);
    }

    /**
     * Show a preview for the given action.
     */
    show(action: Action): void {
        const editor = vscode.window.activeTextEditor;
        
        // Clear previous preview
        this.clear();
        
        this.currentAction = action;
        this.visible = true;

        // Route to appropriate renderer based on action type
        switch (action.kind) {
            case 'editInsert':
                this.showInsertPreview(action, editor);
                break;

            case 'editReplace':
                this.showReplacePreview(action, editor);
                break;

            case 'editDelete':
                this.showDeletePreview(action, editor);
                break;

            case 'terminalSendText':
                this.showTerminalCommandPreview(action, editor);
                break;

            case 'setSelections':
                this.showCursorMovePreview(action, editor);
                break;

            case 'openFile':
                this.showFileSwitchPreview(action, editor);
                break;

            case 'terminalShow':
            case 'showTextDocument':
                // These don't need previews
                break;
        }
    }

    /**
     * Clear all preview UI.
     */
    clear(): void {
        this.decorationPool.clearAll();
        this.inlineProvider.clearAction();
        this.hoverProvider.clearAction();
        this.currentAction = null;
        this.visible = false;
    }

    /**
     * Check if a preview is currently visible.
     */
    isVisible(): boolean {
        return this.visible;
    }

    /**
     * Get the current action being previewed.
     */
    getCurrentAction(): Action | null {
        return this.currentAction;
    }

    /**
     * Show the pending action in a quick pick (for terminal focus scenario).
     */
    async showQuickPick(): Promise<QuickPickResult> {
        if (!this.currentAction) {
            return null;
        }
        return showPendingActionQuickPick(this.currentAction);
    }

    /**
     * Dispose all resources.
     */
    dispose(): void {
        this.decorationPool.dispose();
        this.hoverProviderDisposable?.dispose();
    }

    // -------------------- Preview Renderers --------------------

    /**
     * Check if an action can use inline completion (ghost text).
     * Only pure insertions at/after cursor position can use inline completion.
     * All other cases (replacements, inserts before cursor) use decorators.
     */
    private canUseInlineCompletion(action: Action, editor: vscode.TextEditor): boolean {
        // Only editInsert can use inline completion
        if (action.kind !== 'editInsert') {
            return false;
        }
        
        const cursor = editor.selection.active;
        const insertPos = toVscodePosition(action.position);
        
        // Can use inline if insert position is at or after cursor
        return insertPos.isAfterOrEqual(cursor);
    }

    /**
     * Show preview for text insertion.
     * Case 1: Insert at/after cursor → inline completion (ghost text)
     * Case 2: Insert before cursor → decorations
     */
    private showInsertPreview(action: { kind: 'editInsert'; position: [number, number]; text: string }, editor?: vscode.TextEditor): void {
        if (!editor) {
            return;
        }
        
        const insertPos = toVscodePosition(action.position);
        const anchorLine = Math.min(action.position[0], editor.document.lineCount - 1);
        
        if (this.canUseInlineCompletion(action, editor)) {
            // Case 1: Use inline completion - clean ghost text
            this.inlineProvider.setAction(action);
        } else {
            // Case 2: Use decorations - show green insertion block
            this.showInsertionBlock(editor, anchorLine, action.text);
        }
        
        // Set up hover provider for detailed view
        this.hoverProvider.setAction(action, anchorLine);
    }

    /**
     * Show preview for text replacement using decorations.
     * Case 1: Pure insertion (no deletions) → show only inserted text inline in green
     * Case 2: Has deletions → decorations (red deletion + green addition)
     *         - If coherent (single substring replacement): show green inline after red
     *         - If not coherent (scattered changes): show green block on next line
     */
    private showReplacePreview(action: { kind: 'editReplace'; range: { start: [number, number]; end: [number, number] }; text: string }, editor?: vscode.TextEditor): void {
        if (!editor) {
            return;
        }

        const range = toVscodeRange(action.range);
        const oldText = editor.document.getText(range);
        
        // Case 1: Check for pure insertion first (no deletions)
        const pureInsertion = analyzePureInsertion(editor.document, range, action.text);
        if (pureInsertion.isPureInsertion && pureInsertion.insertionPosition && pureInsertion.insertionText) {
            // Pure insertion: show only the new text inline in green (no red)
            this.showInlineInsertion(editor, pureInsertion.insertionPosition, pureInsertion.insertionText);
        } else {
            // Case 2: Has deletions - show red strikethrough
            const deletionRanges = computeDeletionRanges(editor.document, range, action.text);
            
            if (deletionRanges.length > 0) {
                const decorationOptions: vscode.DecorationOptions[] = deletionRanges.map(r => ({
                    range: r
                }));
                this.decorationPool.setDecorations(editor, 'deletion-char', decorationOptions);
            } else if (!range.isEmpty) {
                // Highlight entire range if no char-level diff but range is not empty
                this.decorationPool.setDecorations(editor, 'deletion', [{ range }]);
            }
            
            // Green highlight on text being added - only if there's actual new content
            // Don't show if it's purely a deletion (new text is subset of old text)
            if (hasInsertions(oldText, action.text)) {
                // Check if this is a coherent single-substring replacement
                const coherent = analyzeCoherentReplacement(editor.document, range, action.text);
                
                if (coherent.isCoherent && coherent.deletionRange && coherent.insertionText) {
                    // Coherent: show green text inline right after the red deletion
                    this.showInlineInsertion(editor, coherent.deletionRange.end, coherent.insertionText);
                } else {
                    // Not coherent: show green block on next line
                    this.showInsertionBlock(editor, range.end.line, action.text);
                }
            }
        }

        // Set hover provider for full details
        this.hoverProvider.setAction(action, range.start.line);
    }

    /**
     * Show inserted text inline at a specific position (right after deleted text).
     * Used for coherent single-substring replacements.
     */
    private showInlineInsertion(editor: vscode.TextEditor, position: vscode.Position, text: string): void {
        // Format text for display
        const displayText = text.replace(/\n/g, '↵').replace(/\t/g, '→');
        const truncatedText = truncate(displayText, 60);
        
        const decorationOptions: vscode.DecorationOptions[] = [{
            range: new vscode.Range(position, position),
            renderOptions: {
                after: {
                    contentText: truncatedText,
                    color: COLORS.insertion.foreground,
                    backgroundColor: COLORS.insertion.background,
                    fontStyle: 'normal',
                    border: '1px solid',
                    borderColor: COLORS.insertion.border,
                }
            }
        }];

        this.decorationPool.setDecorations(editor, 'insertion-inline', decorationOptions);
    }

    /**
     * Show the new/inserted text with green highlight as a block after the specified line.
     */
    private showInsertionBlock(editor: vscode.TextEditor, afterLine: number, text: string): void {
        const anchorLine = Math.min(afterLine, editor.document.lineCount - 1);
        const anchorPos = new vscode.Position(anchorLine, Number.MAX_SAFE_INTEGER);
        
        // Format text for display (escape for CSS content)
        const displayText = text.replace(/\n/g, '↵').replace(/\t/g, '→');
        const truncatedText = truncate(displayText, 80);
        
        const decorationOptions: vscode.DecorationOptions[] = [{
            range: new vscode.Range(anchorPos, anchorPos),
            renderOptions: {
                after: {
                    contentText: `  + ${truncatedText}`,
                    color: COLORS.insertion.foreground,
                    backgroundColor: COLORS.insertion.background,
                    fontStyle: 'normal',
                    margin: '0 0 0 2ch',
                    border: '1px solid',
                    borderColor: COLORS.insertion.border,
                }
            }
        }];

        this.decorationPool.setDecorations(editor, 'insertion-block', decorationOptions);
    }

    /**
     * Show preview for text deletion with strikethrough decoration.
     */
    private showDeletePreview(action: { kind: 'editDelete'; range: { start: [number, number]; end: [number, number] } }, editor?: vscode.TextEditor): void {
        if (!editor) {
            return;
        }

        const range = toVscodeRange(action.range);
        
        // Highlight the deletion range
        this.decorationPool.setDecorations(editor, 'deletion', [{ range }]);

        // Set hover provider
        this.hoverProvider.setAction(action, range.start.line);
    }

    /**
     * Show preview for terminal command with indicator decoration.
     */
    private showTerminalCommandPreview(action: { kind: 'terminalSendText'; text: string }, editor?: vscode.TextEditor): void {
        if (!editor) {
            return;
        }

        const anchorLine = this.getVisibleAnchorLine(editor);
        const cmdPreview = truncate(action.text, 60);
        
        this.showMetaIndicator(editor, anchorLine, '$(terminal)', `Run: ${cmdPreview}`, COLORS.terminal);
        this.hoverProvider.setAction(action, anchorLine);
    }

    /**
     * Show preview for cursor movement with indicator decoration.
     */
    private showCursorMovePreview(action: { kind: 'setSelections'; selections: Array<{ start: [number, number]; end: [number, number] }> }, editor?: vscode.TextEditor): void {
        if (!editor) {
            return;
        }

        const targetLine = action.selections[0].start[0];
        const targetPos = new vscode.Position(targetLine, action.selections[0].start[1]);
        const isTargetVisible = editor.visibleRanges.some(r => r.contains(targetPos));

        let anchorLine: number;
        let icon: string;
        let label: string;

        if (isTargetVisible) {
            // Target is visible, show indicator at target
            anchorLine = targetLine;
            icon = '$(arrow-right)';
            label = 'Move cursor here';
        } else {
            // Target is off-screen, show indicator at edge of visible area
            anchorLine = this.getVisibleAnchorLine(editor);
            const direction = targetLine < anchorLine ? '↑' : '↓';
            icon = `$(arrow-${targetLine < anchorLine ? 'up' : 'down'})`;
            label = `Go to line ${targetLine + 1}`;
        }

        this.showMetaIndicator(editor, anchorLine, icon, label, COLORS.cursorMove);
        this.hoverProvider.setAction(action, anchorLine);
    }

    /**
     * Show preview for file switch with indicator decoration.
     */
    private showFileSwitchPreview(action: { kind: 'openFile'; filePath: string; selections?: Array<{ start: [number, number]; end: [number, number] }> }, editor?: vscode.TextEditor): void {
        if (!editor) {
            return;
        }

        const anchorLine = this.getVisibleAnchorLine(editor);
        const fileName = action.filePath.split(/[/\\]/).pop() || action.filePath;
        const targetLine = action.selections?.[0]?.start[0];
        
        const label = targetLine !== undefined
            ? `Open: ${fileName}:${targetLine + 1}`
            : `Open: ${fileName}`;

        this.showMetaIndicator(editor, anchorLine, '$(file)', label, COLORS.fileSwitch);
        this.hoverProvider.setAction(action, anchorLine);
    }

    // -------------------- Helper Methods --------------------

    /**
     * Show a meta-action indicator decoration at the specified line.
     */
    private showMetaIndicator(
        editor: vscode.TextEditor,
        line: number,
        icon: string,
        label: string,
        color: vscode.ThemeColor
    ): void {
        const anchorPos = new vscode.Position(line, Number.MAX_SAFE_INTEGER);
        const range = new vscode.Range(anchorPos, anchorPos);

        const decorationOptions: vscode.DecorationOptions[] = [{
            range,
            renderOptions: {
                after: {
                    contentText: `  ${icon} ${label}`,
                    color: color,
                    fontStyle: 'italic',
                    margin: '0 0 0 2ch',
                }
            }
        }];

        this.decorationPool.setDecorations(editor, 'meta-indicator', decorationOptions);
    }

    /**
     * Get a visible anchor line for decorations.
     * Returns the line of the cursor if visible, or a line at the edge of the visible area.
     */
    private getVisibleAnchorLine(editor: vscode.TextEditor): number {
        const cursor = editor.selection.active;
        const isVisible = editor.visibleRanges.some(r => r.contains(cursor));

        if (isVisible) {
            return cursor.line;
        }

        if (editor.visibleRanges.length > 0) {
            const firstVisible = editor.visibleRanges[0];
            const lastVisible = editor.visibleRanges[editor.visibleRanges.length - 1];

            if (cursor.isBefore(firstVisible.start)) {
                return firstVisible.start.line;
            } else {
                return lastVisible.end.line;
            }
        }

        return 0;
    }

}

