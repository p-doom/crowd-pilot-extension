import * as vscode from 'vscode';

/**
 * Theme colors for consistent styling across light/dark modes.
 */
export const COLORS = {
    // Code changes: use VS Code's built-in diff colors
    deletion: {
        background: new vscode.ThemeColor('diffEditor.removedTextBackground'),
        border: new vscode.ThemeColor('diffEditor.removedTextBorder'),
    },
    insertion: {
        background: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
        border: new vscode.ThemeColor('diffEditor.insertedTextBorder'),
        foreground: new vscode.ThemeColor('editor.foreground'),
    },

    // Meta actions: use editor widget colors for consistency
    metaAction: {
        foreground: new vscode.ThemeColor('editorWidget.foreground'),
        background: new vscode.ThemeColor('editorWidget.background'),
        border: new vscode.ThemeColor('editorWidget.border'),
    },

    // Action-specific accents
    terminal: new vscode.ThemeColor('terminal.ansiGreen'),
    fileSwitch: new vscode.ThemeColor('textLink.foreground'),
    cursorMove: new vscode.ThemeColor('editorCursor.foreground'),
};

/**
 * Pool of reusable decoration types to avoid memory leaks and flickering.
 * Created once, reused for all previews.
 */
export class DecorationPool {
    private types: Map<string, vscode.TextEditorDecorationType> = new Map();

    constructor() {
        // Deletion highlight for entire ranges (editDelete)
        this.types.set('deletion', vscode.window.createTextEditorDecorationType({
            backgroundColor: COLORS.deletion.background,
            borderColor: COLORS.deletion.border,
            borderStyle: 'solid',
            borderWidth: '1px',
            textDecoration: 'line-through',
        }));

        // Character-level deletion highlight (for diffs in editReplace)
        this.types.set('deletion-char', vscode.window.createTextEditorDecorationType({
            backgroundColor: COLORS.deletion.background,
            textDecoration: 'line-through',
            // No border: cleaner for individual character highlights
        }));

        // Insertion block: shows new text with green highlight on next line
        // contentText is set per-decoration via renderOptions
        this.types.set('insertion-block', vscode.window.createTextEditorDecorationType({
            // Base styles: content set via DecorationOptions.renderOptions
        }));

        // Inline insertion: shows new text right after deleted text (same line)
        // contentText is set per-decoration via renderOptions
        this.types.set('insertion-inline', vscode.window.createTextEditorDecorationType({
            // Base styles: content set via DecorationOptions.renderOptions
        }));

        // Meta-action indicator (terminal, file switch, cursor move)
        // Note: contentText is set per-decoration via renderOptions
        this.types.set('meta-indicator', vscode.window.createTextEditorDecorationType({
            // Base styles: specific content/colors set via DecorationOptions.renderOptions
        }));

        // Terminal command indicator
        this.types.set('terminal-indicator', vscode.window.createTextEditorDecorationType({
            // Styles applied via renderOptions for flexibility
        }));

        // File switch indicator
        this.types.set('file-indicator', vscode.window.createTextEditorDecorationType({
            // Styles applied via renderOptions for flexibility
        }));

        // Cursor move indicator
        this.types.set('cursor-indicator', vscode.window.createTextEditorDecorationType({
            // Styles applied via renderOptions for flexibility
        }));
    }

    /**
     * Get a decoration type by key.
     */
    get(typeKey: string): vscode.TextEditorDecorationType | undefined {
        return this.types.get(typeKey);
    }

    /**
     * Apply decorations to an editor.
     */
    setDecorations(
        editor: vscode.TextEditor,
        typeKey: string,
        options: vscode.DecorationOptions[]
    ): void {
        const type = this.types.get(typeKey);
        if (type) {
            editor.setDecorations(type, options);
        }
    }

    /**
     * Clear all decorations from the active editor.
     */
    clearAll(editor?: vscode.TextEditor): void {
        const targetEditor = editor ?? vscode.window.activeTextEditor;
        if (targetEditor) {
            for (const type of this.types.values()) {
                targetEditor.setDecorations(type, []);
            }
        }
    }

    /**
     * Clear a specific decoration type.
     */
    clear(editor: vscode.TextEditor, typeKey: string): void {
        const type = this.types.get(typeKey);
        if (type) {
            editor.setDecorations(type, []);
        }
    }

    /**
     * Dispose all decoration types. Call on extension deactivation.
     */
    dispose(): void {
        for (const type of this.types.values()) {
            type.dispose();
        }
        this.types.clear();
    }
}


