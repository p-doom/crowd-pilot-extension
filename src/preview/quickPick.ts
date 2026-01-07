import * as vscode from 'vscode';
import { Action, truncate } from './types';

/**
 * Result of the quick pick interaction.
 */
export type QuickPickResult = 'accept' | 'dismiss' | null;

/**
 * Show a quick pick modal for the pending action.
 * Used when terminal is focused and decorations can't be shown.
 */
export async function showPendingActionQuickPick(action: Action): Promise<QuickPickResult> {
    const detail = formatActionDetail(action);
    
    const items: vscode.QuickPickItem[] = [
        { 
            label: '$(check) Accept', 
            description: 'Execute this action',
            detail: detail
        },
        { 
            label: '$(x) Dismiss', 
            description: 'Cancel this suggestion'
        },
    ];

    const result = await vscode.window.showQuickPick(items, {
        title: 'Pending Suggestion',
        placeHolder: getActionSummary(action),
        ignoreFocusOut: false,
    });

    if (result?.label.includes('Accept')) {
        return 'accept';
    }
    if (result?.label.includes('Dismiss')) {
        return 'dismiss';
    }
    return null;
}

/**
 * Get a short summary of the action for the quick pick placeholder.
 */
function getActionSummary(action: Action): string {
    switch (action.kind) {
        case 'terminalSendText':
            return `Run terminal command`;
        case 'openFile':
            const fileName = action.filePath.split(/[/\\]/).pop() || action.filePath;
            return `Open file: ${fileName}`;
        case 'setSelections':
            return `Move cursor to line ${action.selections[0].start[0] + 1}`;
        case 'editInsert':
            return 'Insert text';
        case 'editReplace':
            return 'Replace text';
        case 'editDelete':
            return `Delete lines ${action.range.start[0] + 1}–${action.range.end[0] + 1}`;
        case 'terminalShow':
            return 'Show terminal';
        case 'showTextDocument':
            return 'Show document';
        default:
            return 'Execute action';
    }
}

/**
 * Format the full action detail for display in quick pick.
 */
function formatActionDetail(action: Action): string {
    switch (action.kind) {
        case 'terminalSendText':
            return action.text;
        case 'openFile':
            if (action.selections?.[0]) {
                const line = action.selections[0].start[0] + 1;
                return `${action.filePath}:${line}`;
            }
            return action.filePath;
        case 'setSelections':
            const sel = action.selections[0];
            return `Line ${sel.start[0] + 1}, Column ${sel.start[1] + 1}`;
        case 'editInsert':
            return truncate(action.text, 200);
        case 'editReplace':
            return truncate(action.text, 200);
        case 'editDelete':
            return `Lines ${action.range.start[0] + 1} to ${action.range.end[0] + 1}`;
        default:
            return '';
    }
}




