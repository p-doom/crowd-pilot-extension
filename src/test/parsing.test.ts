import * as assert from 'assert';
import {
	computeChangedLineRange,
	computeMinimalChangeRange,
	extractLastCodeBlock,
	rebaseModelResponse,
	removeCursorMarker,
} from '../utils/parsing';

suite('Parsing Utilities', () => {
	suite('extractLastCodeBlock', () => {
		test('extracts last fenced block', () => {
			const text = [
				'Intro',
				'```',
				'old',
				'```',
				'```',
				'new',
				'```',
			].join('\n');
			assert.strictEqual(extractLastCodeBlock(text), 'new');
		});
	});

	suite('computeChangedLineRange', () => {
		test('returns undefined for identical texts', () => {
			const text = 'line 1\nline 2\nline 3';
			assert.strictEqual(computeChangedLineRange(text, text), undefined);
		});

		test('detects middle-line change', () => {
			const oldText = 'line 1\nline 2\nline 3';
			const newText = 'line 1\nmodified\nline 3';
			assert.deepStrictEqual(computeChangedLineRange(oldText, newText), { start: 1, end: 1 });
		});
	});

	suite('computeMinimalChangeRange', () => {
		test('computes minimal change for single-line modification', () => {
			const oldText = 'def foo():\n    pass\n    return None';
			const newText = 'def foo():\n    x = 42\n    return None';
			assert.deepStrictEqual(computeMinimalChangeRange(oldText, newText), {
				oldStart: 1,
				oldEnd: 1,
				newText: '    x = 42',
			});
		});

		test('safety: rejects large destructive mismatch', () => {
			const oldText = [
				'def fib(n):',
				'    if n <= 1:',
				'        return n',
				'    return fib(n-1) + fib(n-2)',
				'',
				'class Fibonacci:',
				'    def __init__(self):',
				'        self.cached = {}',
				'',
				'    def calculate()',
			].join('\n');
			const newText = [
				'    def calculate(self, n):',
				'        if n in self.cached:',
				'            return self.cached[n]',
				'        return n',
			].join('\n');
			assert.strictEqual(computeMinimalChangeRange(oldText, newText), undefined);
		});
	});

	suite('rebaseModelResponse', () => {
		test('rebases against current editable text', () => {
			const originalText = 'def foo';
			const modelOutput = 'def foo():\n    pass';
			const currentText = 'def foo()';
			const result = rebaseModelResponse(originalText, modelOutput, currentText);
			assert.ok(result !== undefined);
			assert.ok(result?.newText.includes('pass'));
		});
	});

	suite('removeCursorMarker', () => {
		test('removes cursor marker', () => {
			assert.strictEqual(removeCursorMarker('def foo(<|user_cursor|>):'), 'def foo():');
		});
	});
});
