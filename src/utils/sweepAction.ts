import * as path from 'path';

export type SweepParsedEdit = {
	targetFile: string;
	kind: string;
	startLine: number;
	endLine?: number | null;
	text?: string | null;
};

export type SweepAction =
	| { kind: 'editInsert'; position: [number, number]; text: string; autoAppendedTrailingNewline?: boolean }
	| { kind: 'editDelete'; range: { start: [number, number]; end: [number, number] } }
	| { kind: 'editReplace'; range: { start: [number, number]; end: [number, number] }; text: string; autoAppendedTrailingNewline?: boolean }
	| { kind: 'openFile'; filePath: string };

export type DocSnapshot = {
	activeFilePath: string;
	lineCount: number;
	lastLineLength: number;
};

/**
 * Convert serializer Sweep parsed edit to extension action payload.
 */
export function parsedSweepEditToAction(
	edit: SweepParsedEdit,
	doc: DocSnapshot
): SweepAction | undefined {
	if (path.normalize(edit.targetFile) !== path.normalize(doc.activeFilePath)) {
		return { kind: 'openFile', filePath: edit.targetFile };
	}

	const startLine1 = Math.max(1, Number(edit.startLine));
	if (!Number.isFinite(startLine1)) {
		return undefined;
	}
	const endLine1Raw = edit.endLine === null || edit.endLine === undefined ? undefined : Number(edit.endLine);
	const endLine1 = endLine1Raw !== undefined && Number.isFinite(endLine1Raw)
		? Math.max(startLine1, endLine1Raw)
		: undefined;

	switch ((edit.kind || '').toLowerCase()) {
		case 'insert':
			return sweepInsertAction(startLine1, typeof edit.text === 'string' ? edit.text : '', doc);
		case 'delete':
			if (endLine1 === undefined) {
				return undefined;
			}
			return sweepDeleteAction(startLine1, endLine1, doc);
		case 'replace':
			if (endLine1 === undefined) {
				return undefined;
			}
			return sweepReplaceAction(startLine1, endLine1, typeof edit.text === 'string' ? edit.text : '', doc);
		default:
			return undefined;
	}
}

function sweepDeleteAction(startLine1: number, endLine1: number, doc: DocSnapshot): SweepAction | undefined {
	if (doc.lineCount <= 0) {
		return undefined;
	}
	const startLine0 = Math.max(0, startLine1 - 1);
	const endLine0 = Math.max(0, endLine1 - 1);

	let endPosLine = endLine0 + 1;
	let endPosChar = 0;
	if (endPosLine >= doc.lineCount) {
		endPosLine = doc.lineCount - 1;
		endPosChar = doc.lastLineLength;
	}
	return {
		kind: 'editDelete',
		range: {
			start: [startLine0, 0],
			end: [endPosLine, endPosChar],
		},
	};
}

function sweepReplaceAction(startLine1: number, endLine1: number, text: string, doc: DocSnapshot): SweepAction | undefined {
	if (doc.lineCount <= 0) {
		return undefined;
	}
	const startLine0 = Math.max(0, startLine1 - 1);
	const endLine0 = Math.max(0, endLine1 - 1);
	let endPosLine = endLine0 + 1;
	let endPosChar = 0;
	if (endPosLine >= doc.lineCount) {
		endPosLine = doc.lineCount - 1;
		endPosChar = doc.lastLineLength;
	}
	const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const autoAppendedTrailingNewline = !normalizedText.endsWith('\n');
	const payload = autoAppendedTrailingNewline ? `${normalizedText}\n` : normalizedText;
	return {
		kind: 'editReplace',
		range: { start: [startLine0, 0], end: [endPosLine, endPosChar] },
		text: payload,
		...(autoAppendedTrailingNewline ? { autoAppendedTrailingNewline: true } : {}),
	};
}

function sweepInsertAction(startLine1: number, text: string, doc: DocSnapshot): SweepAction | undefined {
	const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	if (!normalizedText) {
		return undefined;
	}
	const autoAppendedTrailingNewline = !normalizedText.endsWith('\n');
	const payload = autoAppendedTrailingNewline ? `${normalizedText}\n` : normalizedText;
	const insertLine0 = Math.max(0, startLine1 - 1);
	if (insertLine0 >= doc.lineCount) {
		const needsLeadingNewline = doc.lineCount > 0;
		return {
			kind: 'editInsert',
			position: [doc.lineCount, 0],
			text: needsLeadingNewline ? `\n${payload}` : payload,
			...(autoAppendedTrailingNewline ? { autoAppendedTrailingNewline: true } : {}),
		};
	}
	return {
		kind: 'editInsert',
		position: [insertLine0, 0],
		text: payload,
		...(autoAppendedTrailingNewline ? { autoAppendedTrailingNewline: true } : {}),
	};
}
