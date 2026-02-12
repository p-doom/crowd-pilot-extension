/**
 * Advance a cursor position by inserted text.
 * Handles LF/CRLF/CR newline variants consistently.
 */
export function advancePositionByText(
	start: [number, number],
	text: string
): [number, number] {
	if (!text) {
		return start;
	}

	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const parts = normalized.split('\n');
	if (parts.length === 1) {
		return [start[0], start[1] + parts[0].length];
	}
	return [start[0] + parts.length - 1, parts[parts.length - 1].length];
}

/**
 * Remove exactly one trailing newline sequence.
 * Supports LF, CRLF, and CR endings.
 */
export function dropSingleTrailingNewline(text: string): string {
	if (!text) {
		return text;
	}
	if (text.endsWith('\r\n')) {
		return text.slice(0, -2);
	}
	if (text.endsWith('\n') || text.endsWith('\r')) {
		return text.slice(0, -1);
	}
	return text;
}
