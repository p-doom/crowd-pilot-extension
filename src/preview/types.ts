import * as vscode from 'vscode';

/**
 * Action types that can be previewed and executed.
 */
export type Action =
    | { kind: 'showTextDocument' }
    | { kind: 'setSelections'; selections: Array<{ start: [number, number]; end: [number, number] }> }
    | { kind: 'editInsert'; position: [number, number]; text: string }
    | { kind: 'editDelete'; range: { start: [number, number]; end: [number, number] } }
    | { kind: 'editReplace'; range: { start: [number, number]; end: [number, number] }; text: string }
    | { kind: 'terminalShow' }
    | { kind: 'terminalSendText'; text: string }
    | { kind: 'openFile'; filePath: string; selections?: Array<{ start: [number, number]; end: [number, number] }> };

/**
 * Convert action range to VS Code Range.
 */
export function toVscodeRange(range: { start: [number, number]; end: [number, number] }): vscode.Range {
    return new vscode.Range(
        new vscode.Position(range.start[0], range.start[1]),
        new vscode.Position(range.end[0], range.end[1])
    );
}

/**
 * Convert action position to VS Code Position.
 */
export function toVscodePosition(position: [number, number]): vscode.Position {
    return new vscode.Position(position[0], position[1]);
}

/**
 * Truncate text to a maximum length with ellipsis.
 */
export function truncate(text: string, maxLength: number): string {
    const oneLine = text.replace(/\r?\n/g, '↵');
    if (oneLine.length <= maxLength) {
        return oneLine;
    }
    return oneLine.slice(0, maxLength - 1) + '…';
}


