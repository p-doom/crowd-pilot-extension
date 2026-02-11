/**
 * Parsing utilities for model responses and edit computation.
 * Extracted for testability without VS Code dependencies.
 */

export type LineRange = { start: number; end: number };

export type MinimalChangeRange = {
	oldStart: number;  // First line that differs in old text
	oldEnd: number;    // Last line that differs in old text (inclusive)
	newText: string;   // The replacement text for just those lines
};

/**
 * Extract the last code block from model response text.
 * Handles fenced code blocks with 3+ backticks.
 */
export function extractLastCodeBlock(text: string): string | undefined {
	let lastBlock: string | undefined;
	let searchStart = 0;

	while (true) {
		const start = text.indexOf("```", searchStart);
		if (start === -1) {
			break;
		}
		let end = start;
		while (end < text.length && text[end] === "`") {
			end += 1;
		}
		const fence = text.slice(start, end);
		const lineBreak = text.indexOf("\n", end);
		if (lineBreak === -1) {
			break;
		}
		const closing = text.indexOf(`\n${fence}`, lineBreak + 1);
		if (closing === -1) {
			searchStart = end;
			continue;
		}
		lastBlock = text.slice(lineBreak + 1, closing + 1);
		searchStart = closing + fence.length + 1;
	}

	// Only trim trailing whitespace to preserve leading indentation
	return lastBlock?.trimEnd();
}

/**
 * Compute the range of lines that changed between old and new text.
 * Returns undefined if texts are identical.
 */
export function computeChangedLineRange(oldText: string, newText: string): LineRange | undefined {
	const oldLines = oldText.split(/\r?\n/);
	const newLines = newText.split(/\r?\n/);
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}
	if (prefix === oldLines.length && prefix === newLines.length) {
		return undefined;
	}
	const endLine = Math.max(prefix, newLines.length - suffix - 1);
	return { start: prefix, end: Math.max(prefix, endLine) };
}

/**
 * Compute the minimal range of lines that changed between old and new text.
 * Returns the precise start/end lines in the old text and the replacement text.
 * Returns undefined if no change or if the edit looks unsafe (would delete too much).
 */
export function computeMinimalChangeRange(oldText: string, newText: string): MinimalChangeRange | undefined {
	const oldLines = oldText.split(/\r?\n/);
	const newLines = newText.split(/\r?\n/);
	
	// Find common prefix (lines that match at the start)
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix += 1;
	}
	
	// Find common suffix (lines that match at the end)
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) {
		suffix += 1;
	}
	
	// If everything matches, no change
	if (prefix === oldLines.length && prefix === newLines.length) {
		return undefined;
	}
	
	// Compute the changed region
	const oldStart = prefix;
	const oldEnd = Math.max(prefix, oldLines.length - suffix - 1);
	const newStart = prefix;
	const newEnd = Math.max(prefix, newLines.length - suffix - 1);
	
	const linesDeleted = oldEnd - oldStart + 1;
	const linesAdded = newEnd - newStart + 1;
	
	// SAFETY CHECK: If no common prefix (replacing from line 0) AND we would
	// delete significantly more lines than we add, the model likely returned
	// only a portion of the editable region. Reject to avoid deleting user's code.
	if (prefix === 0 && linesDeleted > linesAdded + 3 && linesDeleted > oldLines.length * 0.3) {
		return undefined;
	}
	
	// Extract just the changed lines from new text
	const changedNewLines = newLines.slice(newStart, newEnd + 1);
	
	return {
		oldStart,
		oldEnd,
		newText: changedNewLines.join('\n'),
	};
}

/**
 * Simulate rebasing a model response onto a newer document state.
 * This is used when the user types while waiting for the model response.
 * 
 * @param originalEditableText - The editable text at the time of the model request
 * @param modelNewText - The model's predicted new text for the editable region
 * @param currentEditableText - The current editable text (after user's edits)
 * @returns The rebased change range, or undefined if rebasing isn't possible
 */
export function rebaseModelResponse(
	originalEditableText: string,
	modelNewText: string,
	currentEditableText: string
): MinimalChangeRange | undefined {
	// If current text is the same as original, no rebasing needed
	if (originalEditableText === currentEditableText) {
		return computeMinimalChangeRange(originalEditableText, modelNewText);
	}
	
	// Rebase: diff model's output against current text instead of original
	return computeMinimalChangeRange(currentEditableText, modelNewText);
}

/**
 * Remove cursor marker from text.
 */
export function removeCursorMarker(text: string, marker: string = '<|user_cursor|>'): string {
	return text.replaceAll(marker, '');
}
