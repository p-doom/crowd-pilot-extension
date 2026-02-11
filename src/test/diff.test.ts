import * as assert from 'assert';
import { diffChars, hasInsertions, hasSignificantDiff } from '../utils/diff';

suite('Diff Utilities', () => {

	suite('diffChars', () => {

		test('detects simple character insertion', () => {
			const diffs = diffChars('hello', 'hello!');
			const insertions = diffs.filter(d => d.type === 'insert');
			assert.strictEqual(insertions.length, 1);
			assert.strictEqual(insertions[0].value, '!');
		});

		test('detects simple character deletion', () => {
			const diffs = diffChars('hello!', 'hello');
			const deletions = diffs.filter(d => d.type === 'delete');
			assert.strictEqual(deletions.length, 1);
			assert.strictEqual(deletions[0].value, '!');
		});

		test('detects replacement', () => {
			const diffs = diffChars('hello world', 'hello universe');
			const deletions = diffs.filter(d => d.type === 'delete');
			const insertions = diffs.filter(d => d.type === 'insert');
			
			// "world" deleted, "universe" inserted
			assert.ok(deletions.length > 0);
			assert.ok(insertions.length > 0);
		});

		test('handles identical strings', () => {
			const diffs = diffChars('hello', 'hello');
			const changes = diffs.filter(d => d.type !== 'equal');
			assert.strictEqual(changes.length, 0);
		});

		test('handles empty to non-empty', () => {
			const diffs = diffChars('', 'hello');
			const insertions = diffs.filter(d => d.type === 'insert');
			assert.strictEqual(insertions.length, 1);
			assert.strictEqual(insertions[0].value, 'hello');
		});

		test('handles non-empty to empty', () => {
			const diffs = diffChars('hello', '');
			const deletions = diffs.filter(d => d.type === 'delete');
			assert.strictEqual(deletions.length, 1);
			assert.strictEqual(deletions[0].value, 'hello');
		});

	});

	suite('hasInsertions', () => {

		test('returns true when new content is added', () => {
			const result = hasInsertions('def foo():', 'def foo():\n    pass');
			assert.strictEqual(result, true);
		});

		test('returns false when content is only deleted', () => {
			const result = hasInsertions('def foo():\n    pass', 'def foo():');
			assert.strictEqual(result, false);
		});

		test('returns true for replacement with new content', () => {
			const result = hasInsertions('hello world', 'hello universe');
			assert.strictEqual(result, true);
		});

		test('returns false for identical strings', () => {
			const result = hasInsertions('hello', 'hello');
			assert.strictEqual(result, false);
		});

		test('returns false when insertion is only whitespace', () => {
			const result = hasInsertions('hello', 'hello   ');
			assert.strictEqual(result, false);
		});

		test('returns false for empty new text', () => {
			const result = hasInsertions('hello', '');
			assert.strictEqual(result, false);
		});

	});

	suite('hasSignificantDiff', () => {

		test('returns false for identical strings', () => {
			const result = hasSignificantDiff('hello', 'hello');
			assert.strictEqual(result, false);
		});

		test('returns false for whitespace-only differences', () => {
			const result = hasSignificantDiff('hello world', 'hello  world');
			assert.strictEqual(result, false);
		});

		test('returns true for content differences', () => {
			const result = hasSignificantDiff('hello world', 'hello universe');
			assert.strictEqual(result, true);
		});

		test('returns true for added content', () => {
			const result = hasSignificantDiff('hello', 'hello world');
			assert.strictEqual(result, true);
		});

	});

	suite('Integration: Edit preview scenarios', () => {

		test('detects pure insertion at end of line', () => {
			// User has "def foo(" and model adds "self):"
			const oldText = 'def foo(';
			const newText = 'def foo(self):';
			
			const result = hasInsertions(oldText, newText);
			assert.strictEqual(result, true);
			
			const diffs = diffChars(oldText, newText);
			const insertions = diffs.filter(d => d.type === 'insert');
			assert.ok(insertions.length > 0);
			assert.ok(insertions.some(i => i.value.includes('self')));
		});

		test('detects method body insertion', () => {
			const oldText = `def calculate(self, n):
`;
			const newText = `def calculate(self, n):
    return n * 2
`;
			
			const result = hasInsertions(oldText, newText);
			assert.strictEqual(result, true);
		});

		test('detects line completion', () => {
			const oldText = '    def __init__(self';
			const newText = '    def __init__(self):';
			
			const diffs = diffChars(oldText, newText);
			const insertions = diffs.filter(d => d.type === 'insert');
			assert.ok(insertions.some(i => i.value === '):'));
		});

	});

});
