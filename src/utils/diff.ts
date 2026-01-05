import * as vscode from 'vscode';

// TODO (f.srambical): Make this more idiomatic/performant

/**
 * Represents a segment of a diff result.
 */
interface DiffSegment {
    type: 'equal' | 'insert' | 'delete';
    value: string;
}

/**
 * Simple character-level diff implementation.
 * Uses a basic approach suitable for small text comparisons.
 * For larger texts, consider using the 'diff' npm package.
 */
export function diffChars(oldText: string, newText: string): DiffSegment[] {
    const segments: DiffSegment[] = [];
    
    // Use longest common subsequence approach for character diff
    const lcs = longestCommonSubsequence(oldText, newText);
    
    let oldIndex = 0;
    let newIndex = 0;
    let lcsIndex = 0;
    
    while (oldIndex < oldText.length || newIndex < newText.length) {
        // Handle deletions (chars in old but not in LCS)
        let deletedChars = '';
        while (oldIndex < oldText.length && 
               (lcsIndex >= lcs.length || oldText[oldIndex] !== lcs[lcsIndex])) {
            deletedChars += oldText[oldIndex];
            oldIndex++;
        }
        if (deletedChars) {
            segments.push({ type: 'delete', value: deletedChars });
        }
        
        // Handle insertions (chars in new but not in LCS)
        let insertedChars = '';
        while (newIndex < newText.length && 
               (lcsIndex >= lcs.length || newText[newIndex] !== lcs[lcsIndex])) {
            insertedChars += newText[newIndex];
            newIndex++;
        }
        if (insertedChars) {
            segments.push({ type: 'insert', value: insertedChars });
        }
        
        // Handle equal chars (from LCS)
        let equalChars = '';
        while (lcsIndex < lcs.length && 
               oldIndex < oldText.length && 
               newIndex < newText.length &&
               oldText[oldIndex] === lcs[lcsIndex] && 
               newText[newIndex] === lcs[lcsIndex]) {
            equalChars += lcs[lcsIndex];
            oldIndex++;
            newIndex++;
            lcsIndex++;
        }
        if (equalChars) {
            segments.push({ type: 'equal', value: equalChars });
        }
    }
    
    return segments;
}

/**
 * Compute the longest common subsequence of two strings.
 */
function longestCommonSubsequence(str1: string, str2: string): string {
    const m = str1.length;
    const n = str2.length;
    
    // Create DP table
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    
    // Fill DP table
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (str1[i - 1] === str2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    
    // Backtrack to find LCS
    let lcs = '';
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
        if (str1[i - 1] === str2[j - 1]) {
            lcs = str1[i - 1] + lcs;
            i--;
            j--;
        } else if (dp[i - 1][j] > dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }
    
    return lcs;
}

/**
 * Compute VS Code ranges for characters that will be deleted in a replacement.
 * These are characters in the old text that don't appear in the new text.
 */
export function computeDeletionRanges(
    doc: vscode.TextDocument,
    range: vscode.Range,
    newText: string
): vscode.Range[] {
    const oldText = doc.getText(range);
    const diffs = diffChars(oldText, newText);
    
    const deletions: vscode.Range[] = [];
    let offset = doc.offsetAt(range.start);
    
    for (const segment of diffs) {
        if (segment.type === 'delete') {
            const startPos = doc.positionAt(offset);
            const endPos = doc.positionAt(offset + segment.value.length);
            deletions.push(new vscode.Range(startPos, endPos));
        }
        // Only advance offset for non-inserted parts (delete and equal)
        if (segment.type !== 'insert') {
            offset += segment.value.length;
        }
    }
    
    return deletions;
}

/**
 * Check if two texts have meaningful differences.
 * Returns false if texts are identical or only differ in whitespace.
 */
export function hasSignificantDiff(oldText: string, newText: string): boolean {
    if (oldText === newText) {
        return false;
    }
    // Normalize whitespace and compare
    const normalizedOld = oldText.replace(/\s+/g, ' ').trim();
    const normalizedNew = newText.replace(/\s+/g, ' ').trim();
    return normalizedOld !== normalizedNew;
}

/**
 * Check if the diff between old and new text contains any insertions.
 * Returns true if new text has content that doesn't exist in old text.
 */
export function hasInsertions(oldText: string, newText: string): boolean {
    if (!newText || newText.length === 0) {
        return false;
    }
    
    const diffs = diffChars(oldText, newText);
    return diffs.some(segment => segment.type === 'insert' && segment.value.trim().length > 0);
}

/**
 * Result of analyzing a replacement for coherent inline display.
 */
export interface CoherentReplacement {
    isCoherent: boolean;
    deletionRange?: vscode.Range;  // Range of text being deleted
    insertionText?: string;        // Text to insert inline
}

/**
 * Result of analyzing a pure insertion (no deletions).
 */
export interface PureInsertion {
    isPureInsertion: boolean;
    insertionPosition?: vscode.Position;  // Where to insert
    insertionText?: string;               // Text to insert
}

/**
 * Analyze if a replacement is "coherent" - i.e., a single substring is being
 * replaced by another substring (not multiple scattered changes).
 * 
 * Coherent: "hello world" → "hello universe" (one change)
 * Not coherent: "hello world" → "hi universe" (two separate changes)
 */
export function analyzeCoherentReplacement(
    doc: vscode.TextDocument,
    range: vscode.Range,
    newText: string
): CoherentReplacement {
    const oldText = doc.getText(range);
    const diffs = diffChars(oldText, newText);
    
    // Count change regions (consecutive delete/insert blocks)
    let changeRegions = 0;
    let lastWasChange = false;
    let deletionStart: number | null = null;
    let deletionEnd: number | null = null;
    let insertionText: string | null = null;
    
    let offset = doc.offsetAt(range.start);
    
    for (const segment of diffs) {
        const isChange = segment.type === 'delete' || segment.type === 'insert';
        
        if (isChange && !lastWasChange) {
            // Starting a new change region
            changeRegions++;
            if (changeRegions > 1) {
                // More than one change region - not coherent
                return { isCoherent: false };
            }
        }
        
        if (segment.type === 'delete') {
            if (deletionStart === null) {
                deletionStart = offset;
            }
            deletionEnd = offset + segment.value.length;
        }
        
        if (segment.type === 'insert') {
            if (insertionText === null) {
                insertionText = segment.value;
            } else {
                // Multiple insertion segments in same region - concatenate
                insertionText += segment.value;
            }
        }
        
        // Advance offset for non-inserted parts
        if (segment.type !== 'insert') {
            offset += segment.value.length;
        }
        
        lastWasChange = isChange;
    }
    
    // Must have exactly one change region with both deletion and insertion
    if (changeRegions !== 1 || deletionStart === null || deletionEnd === null || !insertionText) {
        return { isCoherent: false };
    }
    
    const deletionRange = new vscode.Range(
        doc.positionAt(deletionStart),
        doc.positionAt(deletionEnd)
    );
    
    return {
        isCoherent: true,
        deletionRange,
        insertionText
    };
}

/**
 * Analyze if a replacement is a pure insertion - i.e., new text is added
 * without deleting anything from the original.
 * 
 * Pure insertion: "hello world" → "hello beautiful world" (only adds text)
 * Not pure insertion: "hello world" → "hello universe" (replaces "world")
 */
export function analyzePureInsertion(
    doc: vscode.TextDocument,
    range: vscode.Range,
    newText: string
): PureInsertion {
    const oldText = doc.getText(range);
    const diffs = diffChars(oldText, newText);
    
    // Check if there are any deletions - if so, not a pure insertion
    const hasDeletions = diffs.some(segment => segment.type === 'delete');
    if (hasDeletions) {
        return { isPureInsertion: false };
    }
    
    // Count insertion regions (should be exactly one for coherent display)
    let insertionRegions = 0;
    let lastWasInsert = false;
    let insertionPosition: number | null = null;
    let insertionText: string | null = null;
    
    let offset = doc.offsetAt(range.start);
    
    for (const segment of diffs) {
        if (segment.type === 'insert') {
            if (!lastWasInsert) {
                // Starting a new insertion region
                insertionRegions++;
                if (insertionRegions > 1) {
                    // More than one insertion region - not coherent
                    return { isPureInsertion: false };
                }
                insertionPosition = offset;
                insertionText = segment.value;
            } else {
                // Continuing same insertion region
                insertionText = (insertionText || '') + segment.value;
            }
            lastWasInsert = true;
        } else {
            // Equal segment
            offset += segment.value.length;
            lastWasInsert = false;
        }
    }
    
    if (insertionRegions !== 1 || insertionPosition === null || !insertionText) {
        return { isPureInsertion: false };
    }
    
    return {
        isPureInsertion: true,
        insertionPosition: doc.positionAt(insertionPosition),
        insertionText
    };
}

