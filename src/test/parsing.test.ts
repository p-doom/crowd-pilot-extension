import * as assert from 'assert';
import {
	extractLastCodeBlock,
	computeChangedLineRange,
	computeMinimalChangeRange,
	rebaseModelResponse,
	removeCursorMarker,
} from '../utils/parsing';

suite('Parsing Utilities', () => {

	suite('extractLastCodeBlock', () => {

		test('extracts simple code block with triple backticks', () => {
			const text = `Some explanation here.

\`\`\`python
def foo():
    return 42
\`\`\`

More text.`;
			const result = extractLastCodeBlock(text);
			assert.strictEqual(result, 'def foo():\n    return 42');
		});

		test('extracts last code block when multiple exist', () => {
			const text = `First block:
\`\`\`
old code
\`\`\`

Second block:
\`\`\`
new code here
\`\`\``;
			const result = extractLastCodeBlock(text);
			assert.strictEqual(result, 'new code here');
		});

		test('handles five-backtick fences (as used in teacher prompt)', () => {
			const text = `The user wants to complete the function.

\`\`\`\`\`
def calculate(self, n):
    if n in self.cached:
        return self.cached[n]
    return n
\`\`\`\`\``;
			const result = extractLastCodeBlock(text);
			assert.strictEqual(result, 'def calculate(self, n):\n    if n in self.cached:\n        return self.cached[n]\n    return n');
		});

		test('preserves leading indentation', () => {
			const text = `\`\`\`
    class Foo:
        def bar(self):
            pass
\`\`\``;
			const result = extractLastCodeBlock(text);
			assert.strictEqual(result, '    class Foo:\n        def bar(self):\n            pass');
		});

		test('returns undefined for text without code blocks', () => {
			const text = 'Just some plain text without any code blocks.';
			const result = extractLastCodeBlock(text);
			assert.strictEqual(result, undefined);
		});

		test('returns undefined for unclosed code block', () => {
			const text = `\`\`\`
code without closing fence`;
			const result = extractLastCodeBlock(text);
			assert.strictEqual(result, undefined);
		});

		test('handles empty code block', () => {
			// An "empty" code block still needs content - immediate closing is not valid
			// This test verifies that a block with just a newline extracts properly
			const text = "```\n\n```";
			const result = extractLastCodeBlock(text);
			assert.strictEqual(result, '');
		});

		test('handles code block with only whitespace', () => {
			const text = "```\n   \n```";
			const result = extractLastCodeBlock(text);
			// Whitespace-only gets trimmed to empty
			assert.strictEqual(result, '');
		});

	});

	suite('computeChangedLineRange', () => {

		test('returns undefined for identical texts', () => {
			const text = 'line 1\nline 2\nline 3';
			const result = computeChangedLineRange(text, text);
			assert.strictEqual(result, undefined);
		});

		test('detects change in middle line', () => {
			const oldText = 'line 1\nline 2\nline 3';
			const newText = 'line 1\nmodified\nline 3';
			const result = computeChangedLineRange(oldText, newText);
			assert.deepStrictEqual(result, { start: 1, end: 1 });
		});

		test('detects change at start', () => {
			const oldText = 'line 1\nline 2\nline 3';
			const newText = 'modified\nline 2\nline 3';
			const result = computeChangedLineRange(oldText, newText);
			assert.deepStrictEqual(result, { start: 0, end: 0 });
		});

		test('detects change at end', () => {
			const oldText = 'line 1\nline 2\nline 3';
			const newText = 'line 1\nline 2\nmodified';
			const result = computeChangedLineRange(oldText, newText);
			assert.deepStrictEqual(result, { start: 2, end: 2 });
		});

		test('detects insertion of new lines', () => {
			const oldText = 'line 1\nline 3';
			const newText = 'line 1\nline 2\nline 3';
			const result = computeChangedLineRange(oldText, newText);
			assert.deepStrictEqual(result, { start: 1, end: 1 });
		});

	});

	suite('computeMinimalChangeRange', () => {

		test('returns undefined for identical texts', () => {
			const text = 'line 1\nline 2\nline 3';
			const result = computeMinimalChangeRange(text, text);
			assert.strictEqual(result, undefined);
		});

		test('computes minimal change for single line modification', () => {
			const oldText = 'def foo():\n    pass\n    return None';
			const newText = 'def foo():\n    x = 42\n    return None';
			const result = computeMinimalChangeRange(oldText, newText);
			assert.deepStrictEqual(result, {
				oldStart: 1,
				oldEnd: 1,
				newText: '    x = 42',
			});
		});

		test('computes change for appended lines', () => {
			const oldText = 'def foo():\n    pass';
			const newText = 'def foo():\n    pass\n    return 42';
			const result = computeMinimalChangeRange(oldText, newText);
			// When appending, the prefix covers all existing lines
			// So the change starts at the position after the last old line
			assert.deepStrictEqual(result, {
				oldStart: 2,
				oldEnd: 2,
				newText: '    return 42',
			});
		});

		test('SAFETY: rejects partial model response (no prefix match, much shorter)', () => {
			// Simulates model returning only the method body instead of full editable region
			const oldText = `def fib(n):
    if n <= 1:
        return n
    return fib(n-1) + fib(n-2)

class Fibonacci:
    def __init__(self):
        self.cached = {}

    def calculate()`;
			
			// Model only returns the calculate method body
			const newText = `    def calculate(self, n):
        if n in self.cached:
            return self.cached[n]
        return n`;
			
			const result = computeMinimalChangeRange(oldText, newText);
			// Should reject because prefix=0 and would delete many more lines than adding
			assert.strictEqual(result, undefined);
		});

		test('SAFETY: rejects when suffix matches but would delete too much', () => {
			// Edge case: last line "return result" matches in both, but first lines don't
			const oldText = `def fib(n):
    if n <= 1:
        return n
    return fib(n-1) + fib(n-2)

class Fibonacci:
    def calculate(self):
        result = 42
        return result`;
			
			// Model returns just the method body, but "return result" matches at end
			const newText = `    if n in self.cached:
        return self.cached[n]
        return result`;
			
			const result = computeMinimalChangeRange(oldText, newText);
			// Should reject because would delete too many lines from the beginning
			assert.strictEqual(result, undefined);
		});

		test('accepts valid edit with common prefix', () => {
			const oldText = `def foo():
    pass`;
			const newText = `def foo():
    x = 42
    return x`;
			
			const result = computeMinimalChangeRange(oldText, newText);
			assert.ok(result !== undefined);
			assert.strictEqual(result.oldStart, 1);
			assert.strictEqual(result.newText, '    x = 42\n    return x');
		});

	});

	suite('rebaseModelResponse (stale completion handling)', () => {

		test('rebases when user typed what model was going to predict', () => {
			// User had "def foo" and typed "()" while waiting
			// Model returns "def foo():\n    pass"
			const originalText = 'def foo';
			const modelOutput = 'def foo():\n    pass';
			const currentText = 'def foo()';  // User typed "()"
			
			const result = rebaseModelResponse(originalText, modelOutput, currentText);
			
			// Should compute diff between current "def foo()" and model's "def foo():\n    pass"
			// Result: only need to add ":\n    pass"
			assert.ok(result !== undefined);
			assert.strictEqual(result.oldStart, 0);
			assert.strictEqual(result.newText, 'def foo():\n    pass');
		});

		test('rebases multi-line completion with user continuation', () => {
			// User had partial class, typed more while waiting
			const originalText = `class Foo:
    def __init__(self`;
			
			const modelOutput = `class Foo:
    def __init__(self):
        self.value = 0`;
			
			const currentText = `class Foo:
    def __init__(self):`; // User typed "):"
			
			const result = rebaseModelResponse(originalText, modelOutput, currentText);
			
			assert.ok(result !== undefined);
			// Rebasing against current text: line 0 matches, line 1 differs
			// Current has "def __init__(self):", model has "def __init__(self):"
			// Actually they might match! Then only the body needs adding
			assert.ok(result.oldStart >= 1);
		});

		test('returns same result when document unchanged', () => {
			const text = 'def foo():\n    pass';
			const modelOutput = 'def foo():\n    return 42';
			
			const result = rebaseModelResponse(text, modelOutput, text);
			
			assert.ok(result !== undefined);
			assert.strictEqual(result.oldStart, 1);
			assert.strictEqual(result.newText, '    return 42');
		});

		test('handles user typing ahead significantly', () => {
			// User typed a lot while waiting
			const originalText = 'def calculate(';
			const modelOutput = 'def calculate(n):\n    return n * 2';
			const currentText = 'def calculate(n):';
			
			const result = rebaseModelResponse(originalText, modelOutput, currentText);
			
			assert.ok(result !== undefined);
			// After rebasing: current="def calculate(n):", model="def calculate(n):\n    return n * 2"
			// Line 0 doesn't match exactly (current has no newline continuation)
			// So the result includes the full replacement
			assert.ok(result.newText.includes('return n * 2'));
		});

	});

	suite('removeCursorMarker', () => {

		test('removes cursor marker from text', () => {
			const text = 'def foo(<|user_cursor|>):';
			const result = removeCursorMarker(text);
			assert.strictEqual(result, 'def foo():');
		});

		test('removes multiple cursor markers', () => {
			const text = '<|user_cursor|>def foo():<|user_cursor|>';
			const result = removeCursorMarker(text);
			assert.strictEqual(result, 'def foo():');
		});

		test('handles text without cursor marker', () => {
			const text = 'def foo():';
			const result = removeCursorMarker(text);
			assert.strictEqual(result, 'def foo():');
		});

		test('uses custom marker', () => {
			const text = 'def foo(CURSOR):';
			const result = removeCursorMarker(text, 'CURSOR');
			assert.strictEqual(result, 'def foo():');
		});

	});

	suite('Integration: Full model response parsing', () => {

		test('parses complete teacher model response', () => {
			// Simulate a full model response
			const modelResponse = `The user is implementing a Fibonacci calculator. They need to complete the calculate method.

\`\`\`\`\`
class Fibonacci:
    def __init__(self):
        self.cached = {}

    def calculate(self, n):
        if n in self.cached:
            return self.cached[n]
        if n <= 1:
            return n
        result = self.calculate(n-1) + self.calculate(n-2)
        self.cached[n] = result
        return result
\`\`\`\`\``;

			const originalEditableText = `class Fibonacci:
    def __init__(self):
        self.cached = {}

    def calculate()`;

			// Extract code block
			const codeBlock = extractLastCodeBlock(modelResponse);
			assert.ok(codeBlock !== undefined);

			// Remove cursor marker if present
			const cleanedCode = removeCursorMarker(codeBlock);

			// Compute minimal change
			const changeRange = computeMinimalChangeRange(originalEditableText, cleanedCode);
			assert.ok(changeRange !== undefined);
			
			// Should detect that we're changing from line 4 (the calculate definition)
			assert.strictEqual(changeRange.oldStart, 4);
		});

		test('rejects model response that would delete class definition', () => {
			// Model returns only the method body, would delete 8 lines but only add 2
			const modelResponse = `\`\`\`\`\`
    def calculate(self, n):
        return n
\`\`\`\`\``;

			// Larger original to trigger safety check (needs linesDeleted > linesAdded + 3)
			const originalEditableText = `class Fibonacci:
    """A Fibonacci calculator with caching."""
    
    def __init__(self):
        self.cached = {}
        self.calls = 0
    
    def calculate()`;

			const codeBlock = extractLastCodeBlock(modelResponse);
			assert.ok(codeBlock !== undefined);

			const changeRange = computeMinimalChangeRange(originalEditableText, codeBlock);
			// Safety check: prefix=0, deleting 8 lines, adding 2
			// 8 > 2 + 3 = 8 > 5 = true, so should reject
			assert.strictEqual(changeRange, undefined);
		});

	});

});
