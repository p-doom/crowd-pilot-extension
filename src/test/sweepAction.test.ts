import * as assert from 'assert';
import { parsedSweepEditToAction, SweepParsedEdit } from '../utils/sweepAction';

const DOC = {
	activeFilePath: '/a.py',
	lineCount: 3,
	lastLineLength: 2,
};

suite('Sweep Action Mapping', () => {
	test('maps replace edit in active file', () => {
		const edit: SweepParsedEdit = {
			targetFile: '/a.py',
			kind: 'replace',
			startLine: 2,
			endLine: 2,
			text: 'updated',
		};
		const action = parsedSweepEditToAction(edit, DOC);
		assert.deepStrictEqual(action, {
			kind: 'editReplace',
			range: { start: [1, 0], end: [2, 0] },
			text: 'updated\n',
			autoAppendedTrailingNewline: true,
		});
	});

	test('maps cross-file edit to openFile action', () => {
		const edit: SweepParsedEdit = {
			targetFile: '/other.py',
			kind: 'replace',
			startLine: 1,
			endLine: 1,
			text: 'x',
		};
		const action = parsedSweepEditToAction(edit, DOC);
		assert.deepStrictEqual(action, {
			kind: 'openFile',
			filePath: '/other.py',
		});
	});

	test('maps append insert with leading newline at EOF', () => {
		const edit: SweepParsedEdit = {
			targetFile: '/a.py',
			kind: 'insert',
			startLine: 999,
			text: 'tail',
		};
		const action = parsedSweepEditToAction(edit, DOC);
		assert.deepStrictEqual(action, {
			kind: 'editInsert',
			position: [3, 0],
			text: '\ntail\n',
			autoAppendedTrailingNewline: true,
		});
	});

	test('does not mark auto-appended newline when insert already ends with newline', () => {
		const edit: SweepParsedEdit = {
			targetFile: '/a.py',
			kind: 'insert',
			startLine: 2,
			text: 'tail\n',
		};
		const action = parsedSweepEditToAction(edit, DOC);
		assert.deepStrictEqual(action, {
			kind: 'editInsert',
			position: [1, 0],
			text: 'tail\n',
		});
	});

	test('does not mark auto-appended newline when replace already ends with newline', () => {
		const edit: SweepParsedEdit = {
			targetFile: '/a.py',
			kind: 'replace',
			startLine: 1,
			endLine: 1,
			text: 'updated\n',
		};
		const action = parsedSweepEditToAction(edit, DOC);
		assert.deepStrictEqual(action, {
			kind: 'editReplace',
			range: { start: [0, 0], end: [1, 0] },
			text: 'updated\n',
		});
	});
});
