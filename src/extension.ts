import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { Buffer } from 'buffer';


// Configuration helper
function getConfig() {
	const config = vscode.workspace.getConfiguration('crowd-pilot');
	return {
		hostname: config.get<string>('hostname', 'hai001'),
		port: config.get<number>('port', 30000),
		basePath: config.get<string>('basePath', '/v1/chat/completions'),
		modelName: config.get<string>('modelName', 'qwen/qwen3-8b'),
	};
}

// -------------------- Serialization Helpers (mirrors serialization_utils.py) --------------------
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_TERMINATED_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const ANSI_OSC_LINE_FALLBACK_RE = /\x1b\][^\n]*$/g;

// NOTE (f.srambical): Make sure that these are the parameters that were used during serialization
const VIEWPORT_RADIUS = 10;
const COALESCE_RADIUS = 5;

// Minimum average logprob per token threshold for displaying suggestions
// -1.0 ≈ perplexity 2.7 (very confident)
const MIN_AVG_LOGPROB = -1.0;

function cleanText(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

function fencedBlock(language: string | null, content: string): string {
	const lang = (language || '').toLowerCase();
	return `\`\`\`${lang}\n${content}\n\`\`\`\n`;
}

function applyChange(content: string, offset: number, length: number, newText: string): string {
	let base = String(content);
	const text = (newText ?? '').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
	if (offset > base.length) {
		base = base + ' '.repeat(offset - base.length);
	}
	return base.slice(0, offset) + text + base.slice(offset + length);
}

function applyBackspaces(text: string): string {
	const out: string[] = [];
	for (const ch of text) {
		if (ch === '\b') {
			if (out.length > 0) {
				out.pop();
			}
		} else {
			out.push(ch);
		}
	}
	return out.join('');
}

function normalizeTerminalOutput(raw: string): string {
	if (!raw) { return raw; }
	let s = applyBackspaces(raw);
	s = s.replace(ANSI_OSC_TERMINATED_RE, '');
	s = s.split('\n').map(line => line.replace(ANSI_OSC_LINE_FALLBACK_RE, '')).join('\n');
	const resolvedLines: string[] = [];
	for (const seg of s.split('\n')) {
		const parts = seg.split('\r');
		let chosen = '';
		for (let i = parts.length - 1; i >= 0; i--) {
			if (parts[i] !== '') {
				chosen = parts[i];
				break;
			}
		}
		if (chosen === '' && parts.length > 0) {
			chosen = parts[parts.length - 1];
		}
		resolvedLines.push(chosen);
	}
	s = resolvedLines.join('\n');
	s = s.replace(ANSI_CSI_RE, '');
	s = s.replace(/\x07/g, '');
	return s;
}

function lineNumberedOutput(content: string, startLine?: number, endLine?: number): string {
	const lines = content.split(/\r?\n/);
	const total = (lines.length === 1 && lines[0] === '') ? 0 : lines.length;
	if (total === 0) { return ''; }
	const s = startLine !== undefined ? Math.max(1, Math.min(startLine, total)) : 1;
	const e = endLine !== undefined ? Math.max(1, Math.min(endLine, total)) : total;
	const buf: string[] = [];
	for (let idx = s; idx <= e; idx++) {
		const lineText = lines[idx - 1] ?? '';
		buf.push(`${idx.toString().padStart(6, ' ')}\t${lineText}`);
	}
	return buf.join('\n');
}

function serializeComputeViewport(totalLines: number, centerLine: number, radius: number): { start: number; end: number } {
	if (totalLines <= 0) { return { start: 1, end: 0 }; }
	const start = Math.max(1, centerLine - radius);
	const end = Math.min(totalLines, centerLine + radius);
	return { start, end };
}

function escapeSingleQuotesForSed(text: string): string {
	return text.replace(/'/g, "'\"'\"'");
}

type OpcodeTag = "replace" | "delete" | "insert" | "equal";

type Opcode = [OpcodeTag, number, number, number, number];

class SequenceMatcher {
	private a: string[];
	private b: string[];
	private b2j: Map<string, number[]> | null = null;
	private matchingBlocks: Array<{ i: number; j: number; n: number }> | null = null;
	private opcodesCache: Opcode[] | null = null;

	constructor(a: string[], b: string[]) {
		this.a = a;
		this.b = b;
		this.chainB();
	}

	// Exact port of difflib's __chain_b assuming junk=None and autojunk=False
	private chainB() {
		this.b2j = new Map();
		for (let i = 0; i < this.b.length; i++) {
			const elt = this.b[i];
			let indices = this.b2j.get(elt);
			if (!indices) {
				indices = [];
				this.b2j.set(elt, indices);
			}
			indices.push(i);
		}
	}

	// Exact port of difflib's find_longest_match assuming junk=None
	private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number) {
		const b2j = this.b2j!;

		let besti = alo;
		let bestj = blo;
		let bestsize = 0;

		let j2len = new Map<number, number>();

		for (let i = alo; i < ahi; i++) {
			const newj2len = new Map<number, number>();
			const elt = this.a[i];
			const indices = b2j.get(elt);
			if (indices) {
				for (const j of indices) {
					if (j < blo) { continue; }
					if (j >= bhi) { break; }
					const k = (j2len.get(j - 1) ?? 0) + 1;
					newj2len.set(j, k);
					if (k > bestsize) {
						besti = i - k + 1;
						bestj = j - k + 1;
						bestsize = k;
					}
				}
			}
			j2len = newj2len;
		}

		// bjunk is always empty since we assume junk=None
		while (besti > alo && bestj > blo && this.a[besti - 1] === this.b[bestj - 1]) {
			besti--;
			bestj--;
			bestsize++;
		}
		while (
			besti + bestsize < ahi &&
			bestj + bestsize < bhi &&
			this.a[besti + bestsize] === this.b[bestj + bestsize]
		) {
			bestsize++;
		}

		return { i: besti, j: bestj, n: bestsize };
	}

	// Exact port of difflib's get_matching_blocks
	private getMatchingBlocks() {
		if (this.matchingBlocks !== null) { return this.matchingBlocks; }

		const la = this.a.length;
		const lb = this.b.length;

		const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
		const matchingBlocks: Array<{ i: number; j: number; n: number }> = [];

		while (queue.length) {
			const [alo, ahi, blo, bhi] = queue.pop()!;
			const match = this.findLongestMatch(alo, ahi, blo, bhi);
			const { i, j, n } = match;
			if (n > 0) {
				matchingBlocks.push(match);
				if (alo < i && blo < j) {
					queue.push([alo, i, blo, j]);
				}
				if (i + n < ahi && j + n < bhi) {
					queue.push([i + n, ahi, j + n, bhi]);
				}
			}
		}

		// Sort lexicographically by (i, j, n) to match Python's tuple sort behavior
		matchingBlocks.sort((a, b) => {
			if (a.i !== b.i) { return a.i - b.i; }
			if (a.j !== b.j) { return a.j - b.j; }
			return a.n - b.n;
		});

		let i1 = 0;
		let j1 = 0;
		let k1 = 0;
		const result: Array<{ i: number; j: number; n: number }> = [];

		for (const m of matchingBlocks) {
			if (i1 + k1 === m.i && j1 + k1 === m.j) {
				k1 += m.n;
			} else {
				if (k1 > 0) {
					result.push({ i: i1, j: j1, n: k1 });
				}
				i1 = m.i;
				j1 = m.j;
				k1 = m.n;
			}
		}
		if (k1 > 0) {
			result.push({ i: i1, j: j1, n: k1 });
		}

		result.push({ i: la, j: lb, n: 0 });

		this.matchingBlocks = result;
		return result;
	}

	// Exact port of difflib's get_opcodes
	getOpcodes(): Opcode[] {
		if (this.opcodesCache) { return this.opcodesCache; }

		const opcodes: Opcode[] = [];
		let i = 0;
		let j = 0;

		for (const m of this.getMatchingBlocks()) {
			const tag: OpcodeTag = "equal";
			const ai = m.i;
			const bj = m.j;
			const n = m.n;

			let tagToUse: OpcodeTag | null = null;

			if (i < ai && j < bj) {
				tagToUse = "replace";
			} else if (i < ai) {
				tagToUse = "delete";
			} else if (j < bj) {
				tagToUse = "insert";
			}

			if (tagToUse) {
				opcodes.push([tagToUse, i, ai, j, bj]);
			}
			if (n > 0) {
				opcodes.push([tag, ai, ai + n, bj, bj + n]);
			}
			i = ai + n;
			j = bj + n;
		}

		this.opcodesCache = opcodes;
		return opcodes;
	}
}


export function computeChangedBlockLines(before: string, after: string): {
	startBefore: number;
	endBefore: number;
	startAfter: number;
	endAfter: number;
	replacementLines: string[];
} {
	const beforeLines = before.split(/\r?\n/);
	const afterLines = after.split(/\r?\n/);

	const sm = new SequenceMatcher(beforeLines, afterLines);
	const allOpcodes = sm.getOpcodes();
	const nonEqual = allOpcodes.filter(op => op[0] !== "equal");

	if (nonEqual.length === 0) {
		throw new Error(
			"Opcode list cannot be empty! Likely a bug in the diff computation."
		);
	}

	const first = nonEqual[0];
	const last = nonEqual[nonEqual.length - 1];

	// i1/i2 refer to 'before' indices, j1/j2 to 'after'
	const startBefore = Math.max(1, first[1] + 1);
	const endBefore = last[2];
	const startAfter = Math.max(1, first[3] + 1);
	const endAfter = last[4];
	const replacementLines = afterLines.slice(first[3], last[4]);

	return { startBefore, endBefore, startAfter, endAfter, replacementLines };
}
// -------------------- Conversation State Manager --------------------
interface ConversationMessage {
	from: 'User' | 'Assistant';
	value: string;
}

class ConversationStateManager {
	private messages: ConversationMessage[] = [];
	private fileStates: Map<string, string> = new Map();
	private perFileViewport: Map<string, { start: number; end: number } | null> = new Map();
	private filesOpenedInConversation: Set<string> = new Set();
	private terminalOutputBuffer: string[] = [];
	private pendingEditsBefore: Map<string, string | null> = new Map();
	private pendingEditRegions: Map<string, { start: number; end: number } | null> = new Map();

	constructor() {}

	reset(): void {
		this.messages = [];
		this.fileStates.clear();
		this.perFileViewport.clear();
		this.filesOpenedInConversation.clear();
		this.terminalOutputBuffer = [];
		this.pendingEditsBefore.clear();
		this.pendingEditRegions.clear();
	}

	getMessages(): ConversationMessage[] {
		return [...this.messages];
	}

	getFileContent(filePath: string): string {
		return this.fileStates.get(filePath) ?? '';
	}

	private appendMessage(message: ConversationMessage): void {
		this.messages.push(message);
	}

	private maybeCaptureFileContents(filePath: string, content: string): void {
		if (this.filesOpenedInConversation.has(filePath)) {
			return;
		}
		const cmd = `cat -n ${filePath}`;
		this.appendMessage({
			from: 'Assistant',
			value: fencedBlock('bash', cleanText(cmd)),
		});
		const output = lineNumberedOutput(content);
		this.appendMessage({
			from: 'User',
			value: `<stdout>\n${output}\n</stdout>`,
		});
		this.filesOpenedInConversation.add(filePath);
	}

	flushTerminalOutputBuffer(): void {
		if (this.terminalOutputBuffer.length === 0) {
			return;
		}
		const aggregated = this.terminalOutputBuffer.join('');
		const out = normalizeTerminalOutput(aggregated);
		const cleaned = cleanText(out);
		if (cleaned.trim()) {
			this.appendMessage({
				from: 'User',
				value: `<stdout>\n${cleaned}\n</stdout>`,
			});
		}
		this.terminalOutputBuffer = [];
	}

	flushPendingEditForFile(targetFile: string): void {
		const beforeSnapshot = this.pendingEditsBefore.get(targetFile);
		if (beforeSnapshot === null || beforeSnapshot === undefined) {
			return;
		}
		const afterState = this.fileStates.get(targetFile) ?? '';
		if (beforeSnapshot.replace(/\n+$/, '') === afterState.replace(/\n+$/, '')) {
			this.pendingEditsBefore.set(targetFile, null);
			this.pendingEditRegions.set(targetFile, null);
			return;
		}

		const {
			startBefore,
			endBefore,
			startAfter,
			endAfter,
			replacementLines,
		} = computeChangedBlockLines(beforeSnapshot, afterState);

		const beforeTotalLines = beforeSnapshot.split(/\r?\n/).length;
		let sedCmd: string;

		if (endBefore < startBefore) {
			// Pure insertion
			const escapedLines = replacementLines.map(line => escapeSingleQuotesForSed(line));
			const sedPayload = escapedLines.join('\n');
			if (startBefore <= Math.max(1, beforeTotalLines)) {
				sedCmd = `sed -i '${startBefore}i\\\n${sedPayload}' ${targetFile}`;
			} else {
				sedCmd = `sed -i '$a\\\n${sedPayload}' ${targetFile}`;
			}
		} else if (replacementLines.length === 0) {
			// Pure deletion
			sedCmd = `sed -i '${startBefore},${endBefore}d' ${targetFile}`;
		} else {
			// Replacement
			const escapedLines = replacementLines.map(line => escapeSingleQuotesForSed(line));
			const sedPayload = escapedLines.join('\n');
			sedCmd = `sed -i '${startBefore},${endBefore}c\\\n${sedPayload}' ${targetFile}`;
		}

		const totalLines = afterState.split(/\r?\n/).length;
		const center = Math.floor((startAfter + endAfter) / 2);
		const vp = serializeComputeViewport(totalLines, center, VIEWPORT_RADIUS);
		this.perFileViewport.set(targetFile, vp);

		this.maybeCaptureFileContents(targetFile, beforeSnapshot);

		const chainedCmd = `${sedCmd} && cat -n ${targetFile} | sed -n '${vp.start},${vp.end}p'`;
		this.appendMessage({
			from: 'Assistant',
			value: fencedBlock('bash', cleanText(chainedCmd)),
		});

		const viewportOutput = lineNumberedOutput(afterState, vp.start, vp.end);
		this.appendMessage({
			from: 'User',
			value: `<stdout>\n${viewportOutput}\n</stdout>`,
		});

		this.pendingEditsBefore.set(targetFile, null);
		this.pendingEditRegions.set(targetFile, null);
	}

	flushAllPendingEdits(): void {
		for (const fname of this.pendingEditsBefore.keys()) {
			this.flushPendingEditForFile(fname);
		}
	}

	handleTabEvent(filePath: string, textContent: string | null): void {
		this.flushAllPendingEdits();
		this.flushTerminalOutputBuffer();

		if (textContent !== null) {
			const content = textContent.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
			this.fileStates.set(filePath, content);

			const cmd = `cat -n ${filePath}`;
			this.appendMessage({
				from: 'Assistant',
				value: fencedBlock('bash', cleanText(cmd)),
			});
			const output = lineNumberedOutput(content);
			this.appendMessage({
				from: 'User',
				value: `<stdout>\n${output}\n</stdout>`,
			});
			this.filesOpenedInConversation.add(filePath);
		} else {
			// File switch without content snapshot: show current viewport only
			const content = this.fileStates.get(filePath) ?? '';
			const totalLines = content.split(/\r?\n/).length;
			let vp = this.perFileViewport.get(filePath);
			if (!vp || vp.end === 0) {
				vp = serializeComputeViewport(totalLines, 1, VIEWPORT_RADIUS);
				this.perFileViewport.set(filePath, vp);
			}
			if (vp && vp.end >= vp.start) {
				this.maybeCaptureFileContents(filePath, content);
				const cmd = `cat -n ${filePath} | sed -n '${vp.start},${vp.end}p'`;
				this.appendMessage({
					from: 'Assistant',
					value: fencedBlock('bash', cleanText(cmd)),
				});
				const viewportOutput = lineNumberedOutput(content, vp.start, vp.end);
				this.appendMessage({
					from: 'User',
					value: `<stdout>\n${viewportOutput}\n</stdout>`,
				});
			}
		}
	}

	handleContentEvent(filePath: string, offset: number, length: number, newText: string): void {
		this.flushTerminalOutputBuffer();

		const before = this.fileStates.get(filePath) ?? '';
		const newTextStr = newText ?? '';

		// Approximate current edit region in line space
		const startLineCurrent = before.slice(0, offset).split('\n').length;
		const deletedContent = before.slice(offset, offset + length);
		const linesAdded = (newTextStr.match(/\n/g) || []).length;
		const linesDeleted = (deletedContent.match(/\n/g) || []).length;
		const regionStart = startLineCurrent;
		const regionEnd = startLineCurrent + Math.max(linesAdded, linesDeleted, 0);

		// Flush pending edits if this edit is far from the pending region
		let currentRegion = this.pendingEditRegions.get(filePath);
		if (currentRegion !== null && currentRegion !== undefined) {
			const { start: rstart, end: rend } = currentRegion;
			if (regionStart < (rstart - COALESCE_RADIUS) || regionStart > (rend + COALESCE_RADIUS)) {
				this.flushPendingEditForFile(filePath);
				currentRegion = null;
			}
		}

		const after = applyChange(before, offset, length, newText);

		if (this.pendingEditsBefore.get(filePath) === null || this.pendingEditsBefore.get(filePath) === undefined) {
			this.pendingEditsBefore.set(filePath, before);
		}

		// Update/initialize region union
		if (currentRegion === null || currentRegion === undefined) {
			this.pendingEditRegions.set(filePath, { start: regionStart, end: Math.max(regionStart, regionEnd) });
		} else {
			const { start: rstart, end: rend } = currentRegion;
			this.pendingEditRegions.set(filePath, {
				start: Math.min(rstart, regionStart),
				end: Math.max(rend, regionEnd),
			});
		}

		this.fileStates.set(filePath, after);
	}

	handleSelectionEvent(filePath: string, offset: number): void {
		if (this.pendingEditsBefore.get(filePath) !== null && this.pendingEditsBefore.get(filePath) !== undefined) {
			return;
		}

		this.flushTerminalOutputBuffer();

		const content = this.fileStates.get(filePath) ?? '';
		const totalLines = content.split(/\r?\n/).length;
		const targetLine = content.slice(0, offset).split('\n').length;

		let vp = this.perFileViewport.get(filePath);
		let shouldEmit = false;

		if (!vp || vp.end === 0) {
			vp = serializeComputeViewport(totalLines, targetLine, VIEWPORT_RADIUS);
			this.perFileViewport.set(filePath, vp);
			shouldEmit = true;
		} else {
			if (targetLine < vp.start || targetLine > vp.end) {
				vp = serializeComputeViewport(totalLines, targetLine, VIEWPORT_RADIUS);
				this.perFileViewport.set(filePath, vp);
				shouldEmit = true;
			}
		}

		if (shouldEmit && vp && vp.end >= vp.start) {
			this.maybeCaptureFileContents(filePath, content);
			const cmd = `cat -n ${filePath} | sed -n '${vp.start},${vp.end}p'`;
			this.appendMessage({
				from: 'Assistant',
				value: fencedBlock('bash', cleanText(cmd)),
			});
			const viewportOutput = lineNumberedOutput(content, vp.start, vp.end);
			this.appendMessage({
				from: 'User',
				value: `<stdout>\n${viewportOutput}\n</stdout>`,
			});
		}
	}

	handleTerminalCommandEvent(command: string): void {
		this.flushAllPendingEdits();
		this.flushTerminalOutputBuffer();

		const commandStr = command.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
		this.appendMessage({
			from: 'Assistant',
			value: fencedBlock('bash', cleanText(commandStr)),
		});
	}

	handleTerminalOutputEvent(output: string): void {
		const rawOutput = output.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
		this.terminalOutputBuffer.push(rawOutput);
	}

	handleTerminalFocusEvent(): void {
		this.flushAllPendingEdits();
		this.flushTerminalOutputBuffer();
		// No-op for bash transcript; focus changes don't emit commands/output
	}

	handleGitBranchCheckoutEvent(branchInfo: string): void {
		this.flushAllPendingEdits();
		this.flushTerminalOutputBuffer();

		const branchStr = branchInfo.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
		const cleaned = cleanText(branchStr);
		const m = cleaned.match(/to '([^']+)'/);
		if (!m) {
			console.warn(`[crowd-pilot] Could not extract branch name from git checkout message: ${cleaned}`);
			return;
		}
		let branchName = m[1].trim();
		// Safe-quote branch if it contains special characters
		if (/[^A-Za-z0-9._/\\-]/.test(branchName)) {
			branchName = "'" + branchName.replace(/'/g, "'\"'\"'") + "'";
		}
		const cmd = `git checkout ${branchName}`;
		this.appendMessage({
			from: 'Assistant',
			value: fencedBlock('bash', cleanText(cmd)),
		});
	}

	// Finalize and get conversation ready for model
	finalizeForModel(): ConversationMessage[] {
		this.flushAllPendingEdits();
		this.flushTerminalOutputBuffer();
		return this.getMessages();
	}
}

// Global conversation state manager instance
const conversationManager = new ConversationStateManager();

// Track activated files (files whose content we've captured)
const activatedFiles = new Set<string>();

let suggestionsEnabled = true;
let statusBarItem: vscode.StatusBarItem | undefined;

function updateStatusBarItem(): void {
	if (!statusBarItem) { return; }
	if (suggestionsEnabled) {
		statusBarItem.text = '$(lightbulb) crowd-pilot';
		statusBarItem.tooltip = 'crowd-pilot: Tab suggestions enabled (click to disable)';
		statusBarItem.backgroundColor = undefined;
	} else {
		statusBarItem.text = '$(lightbulb-autofix) crowd-pilot';
		statusBarItem.tooltip = 'crowd-pilot: Tab suggestions disabled (click to enable)';
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	}
}

export function activate(context: vscode.ExtensionContext) {

	console.log('[crowd-pilot] Extension activated');

	(async () => {
		const config = vscode.workspace.getConfiguration('terminal.integrated');
		const commandsToSkipShell = config.get<string[]>('commandsToSkipShell', []);
		let updated = false;
		if (!commandsToSkipShell.includes('crowd-pilot.modelRun')) {
			commandsToSkipShell.push('crowd-pilot.modelRun');
			updated = true;
		}
		if (!commandsToSkipShell.includes('crowd-pilot.hideUi')) {
			commandsToSkipShell.push('crowd-pilot.hideUi');
			updated = true;
		}
		if (updated) {
			await config.update('commandsToSkipShell', commandsToSkipShell, vscode.ConfigurationTarget.Global);
		}
	})().catch((err) => console.error('[crowd-pilot] Startup initialization error:', err));

	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'crowd-pilot.toggleSuggestions';
	updateStatusBarItem();
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	const toggleSuggestions = vscode.commands.registerCommand('crowd-pilot.toggleSuggestions', () => {
		suggestionsEnabled = !suggestionsEnabled;
		updateStatusBarItem();
		if (!suggestionsEnabled) {
			hidePreviewUI(true);
		}
		vscode.window.showInformationMessage(
			suggestionsEnabled 
				? '[crowd-pilot]: Tab suggestions enabled' 
				: '[crowd-pilot]: Tab suggestions disabled'
		);
	});

	const hideUi = vscode.commands.registerCommand('crowd-pilot.hideUi', () => {
		hidePreviewUI(true);
	});

	const modelRun = vscode.commands.registerCommand('crowd-pilot.modelRun', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		try {
			if (!previewVisible) { return; }
			let action: PlannedAction | undefined = currentAction;
			if (!action) {
				const single = await requestModelActions(editor);
				currentAction = single;
				action = single;
			}
			if (!action) {
				hidePreviewUI();
				return;
			}
			hidePreviewUI(false);
			await executeAction(action);
			autoShowNextAction();
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Model run failed: ${errorMessage}`);
		}
	});

	const sglangTest = vscode.commands.registerCommand('crowd-pilot.sglangTest', async () => {
		try {
			await callSGLangChat();
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`SGLang test failed: ${errorMessage}`);
		}
	});

	const onSelChange = vscode.window.onDidChangeTextEditorSelection((e) => {
		if (e.textEditor === vscode.window.activeTextEditor) {
			suppressAutoPreview = false;
			schedulePredictionRefresh(true, false);

			const editor = e.textEditor;
			const selection = e.selections[0];
			if (selection) {
				const filePath = editor.document.uri.fsPath;
				const offset = editor.document.offsetAt(selection.start);
				conversationManager.handleSelectionEvent(filePath, offset);
			}
		}
	});

	const onActiveChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
		suppressAutoPreview = false;
		schedulePredictionRefresh(true, false);

		if (editor) {
			const filePath = editor.document.uri.fsPath;
			const currentFileUri = editor.document.uri.toString();
			let tabEventText: string | null = null;

			if (!activatedFiles.has(currentFileUri)) {
				tabEventText = editor.document.getText();
				activatedFiles.add(currentFileUri);
			}

			conversationManager.handleTabEvent(filePath, tabEventText);
		}
	});

	const onDocChange = vscode.workspace.onDidChangeTextDocument((e) => {
		if (vscode.window.activeTextEditor?.document === e.document) {
			suppressAutoPreview = false;
			schedulePredictionRefresh(true, false);

			const filePath = e.document.uri.fsPath;
			for (const change of e.contentChanges) {
				const offset = change.rangeOffset;
				const length = change.rangeLength;
				const newText = change.text;
				conversationManager.handleContentEvent(filePath, offset, length, newText);
			}
		}
	});

	// Terminal focus event
	const onTerminalChange = vscode.window.onDidChangeActiveTerminal((terminal) => {
		if (terminal) {
			conversationManager.handleTerminalFocusEvent();
		}
	});

	// Terminal command execution event
	const onTerminalCommand = vscode.window.onDidStartTerminalShellExecution(async (event) => {
		const commandLine = event.execution.commandLine.value;
		conversationManager.handleTerminalCommandEvent(commandLine);

		// Capture terminal output
		const stream = event.execution.read();
		for await (const data of stream) {
			conversationManager.handleTerminalOutputEvent(data);
		}
	});

	context.subscriptions.push(
		toggleSuggestions,
		hideUi,
		sglangTest,
		modelRun,
		onSelChange,
		onActiveChange,
		onDocChange,
		onTerminalChange,
		onTerminalCommand
	);

	// Initialize: capture current active editor if any
	const initialEditor = vscode.window.activeTextEditor;
	if (initialEditor) {
		const filePath = initialEditor.document.uri.fsPath;
		const currentFileUri = initialEditor.document.uri.toString();
		const tabEventText = initialEditor.document.getText();
		activatedFiles.add(currentFileUri);
		conversationManager.handleTabEvent(filePath, tabEventText);
	}
}

export function deactivate() {}

// -------------------- Plan Types & Execution --------------------
type PlannedAction =
| { kind: 'showTextDocument' }
| { kind: 'setSelections', selections: Array<{ start: [number, number], end: [number, number] }> }
| { kind: 'editInsert', position: [number, number], text: string }
| { kind: 'editDelete', range: { start: [number, number], end: [number, number] } }
| { kind: 'editReplace', range: { start: [number, number], end: [number, number] }, text: string }
| { kind: 'terminalShow' }
| { kind: 'terminalSendText', text: string };

let currentAction: PlannedAction | undefined;

async function executeAction(action: PlannedAction): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	const doc = editor.document;
	const term = vscode.window.terminals[0] ?? vscode.window.createTerminal('Test');
	if (action.kind === 'showTextDocument') {
		await vscode.window.showTextDocument(doc);
		return;
	}
	if (action.kind === 'setSelections') {
		editor.selections = action.selections.map(s => new vscode.Selection(
			new vscode.Position(s.start[0], s.start[1]),
			new vscode.Position(s.end[0], s.end[1])
		));
		if (editor.selections.length > 0) {
			editor.revealRange(editor.selections[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
		return;
	}
	if (action.kind === 'editInsert') {
		await editor.edit((e: vscode.TextEditorEdit) => e.insert(new vscode.Position(action.position[0], action.position[1]), action.text));
		return;
	}
	if (action.kind === 'editDelete') {
		const range = new vscode.Range(
			new vscode.Position(action.range.start[0], action.range.start[1]),
			new vscode.Position(action.range.end[0], action.range.end[1])
		);
		await editor.edit((e: vscode.TextEditorEdit) => e.delete(range));
		return;
	}
	if (action.kind === 'editReplace') {
		const range = new vscode.Range(
			new vscode.Position(action.range.start[0], action.range.start[1]),
			new vscode.Position(action.range.end[0], action.range.end[1])
		);
		await editor.edit((e: vscode.TextEditorEdit) => e.replace(range, action.text));
		return;
	}
	if (action.kind === 'terminalShow') {
		term.show();
		return;
	}
	if (action.kind === 'terminalSendText') {
		term.sendText(action.text);
		return;
	}
}

// -------------------- UI State & Helpers --------------------
const UI_CONTEXT_KEY = 'crowdPilot.uiVisible';
let previewVisible = false;
let decorationDeleteType: vscode.TextEditorDecorationType | undefined;
let decorationReplaceType: vscode.TextEditorDecorationType | undefined;
let decorationReplaceBlockType: vscode.TextEditorDecorationType | undefined;
let mockStep = 0;
let suppressAutoPreview = false;
let latestRequestId = 0;
let currentAbortController: AbortController | undefined;

const PREDICTION_DEBOUNCE_MS = 150;
const PREDICTION_THROTTLE_MS = 300;

type PendingPrediction = { id: number; timer: NodeJS.Timeout };

let nextQueuedPredictionId = 0;
let pendingPredictions: PendingPrediction[] = [];
const cancelledPredictionIds = new Set<number>();
let lastPredictionTimestamp: number | undefined;

function disposePreviewDecorations() {
	try { decorationDeleteType?.dispose(); } catch {}
	try { decorationReplaceType?.dispose(); } catch {}
	try { decorationReplaceBlockType?.dispose(); } catch {}
	decorationDeleteType = undefined;
	decorationReplaceType = undefined;
	decorationReplaceBlockType = undefined;
}

function getDynamicMargin(editor: vscode.TextEditor, anchorLine: number, text: string): string {
	const lines = text.split(/\r?\n/);
	const height = lines.length;
	
	// We need to check the document lines that will be covered by this panel.
	// The panel starts at 'anchorLine' and extends downwards by 'height' lines.
	// However, visually, since it's 'after', it sits to the right of 'anchorLine',
	// and then flows down.
	// So we check document lines from anchorLine to anchorLine + height - 1.
	
	const doc = editor.document;
	let maxLen = 0;
	const startLine = anchorLine;
	const endLine = Math.min(doc.lineCount - 1, anchorLine + height - 1);
	
	for (let i = startLine; i <= endLine; i++) {
		const lineText = doc.lineAt(i).text;
		const len = lineText.replace(/\t/g, '    ').length;
		if (len > maxLen) {
			maxLen = len;
		}
	}
	
	const anchorLineText = doc.lineAt(anchorLine).text;
	const anchorLen = anchorLineText.replace(/\t/g, '    ').length;
	
	const diff = Math.max(0, maxLen - anchorLen);
	const margin = diff + 4; 
	return `${margin}ch`;
}

function showPreviewUI(action: PlannedAction): void {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	disposePreviewDecorations();

	// FIXME (f.srambical): add file switch 
	const next = (action.kind === 'editInsert' || action.kind === 'editDelete' || action.kind === 'editReplace' || action.kind === 'terminalSendText' || action.kind === 'setSelections') ? action : undefined;
	if (!next) {
		previewVisible = false;
		vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
		currentAction = action;
		return;
	}

	const trimText = (t: string) => {
		const oneLine = t.replace(/\r?\n/g, '\\n');
		return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;
	};

	if (next.kind === 'setSelections') {
		const selection = next.selections[0];
		const targetPos = new vscode.Position(selection.start[0], selection.start[1]);
		const isVisible = editor.visibleRanges.some(r => r.contains(targetPos));
		
		let anchorPos = targetPos;
		let label = "↳ Move Cursor Here";

		if (!isVisible && editor.visibleRanges.length > 0) {
			const firstVisible = editor.visibleRanges[0].start;
			const lastVisible = editor.visibleRanges[editor.visibleRanges.length - 1].end;
			
			if (targetPos.isBefore(firstVisible)) {
				anchorPos = editor.document.lineAt(firstVisible.line).range.end;
			} else {
				anchorPos = editor.document.lineAt(lastVisible.line).range.end;
			}

			if (targetPos.line < anchorPos.line) {
				label = `↑ Move Cursor to Line ${targetPos.line + 1}`;
			} else {
				label = `↓ Move Cursor to Line ${targetPos.line + 1}`;
			}
		}

		const margin = getDynamicMargin(editor, anchorPos.line, label);

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "${label}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top;`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(anchorPos, anchorPos) }]);
	} else if (next.kind === 'terminalSendText') {
		const cursor = editor.selection.active;
		const lineEnd = editor.document.lineAt(cursor.line).range.end;
		const summary = trimText(next.text || '');
		const label = `↳ Execute shell command in terminal: ${summary}`;
		const margin = getDynamicMargin(editor, cursor.line, label);

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "${label.replace(/"/g, '\\"')}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top;`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(lineEnd, lineEnd) }]);
	} else if (next.kind === 'editInsert') {
		const posLine = next.position[0];
		const fullBlock = next.text;
		const cssContent = fullBlock
			.replace(/"/g, '\\"')
			.replace(/\r?\n/g, '\\A ');

		const docLineCount = editor.document.lineCount;
		let anchorLine = posLine;
		let shiftUp = true;
		
		if (anchorLine >= docLineCount) {
			anchorLine = docLineCount - 1;
			shiftUp = false;
		}

		const anchorPos = new vscode.Position(anchorLine, Number.MAX_VALUE); 
		
		const marginCheckLine = anchorLine;
		const margin = getDynamicMargin(editor, marginCheckLine, fullBlock);

		const topOffset = '0';

		const beforeDecoration = {
			contentText: '',
			textDecoration: `none; position: absolute; left: 0; width: 100vw; border-top: 1px dashed var(--vscode-charts-purple); top: 0; height: 0; z-index: 99; pointer-events: none;`
		};

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			before: beforeDecoration,
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "${cssContent}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top; top: ${topOffset};`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(anchorPos, anchorPos) }]);
	} else if (next.kind === 'editDelete') {
		const range = new vscode.Range(
			new vscode.Position(next.range.start[0], next.range.start[1]),
			new vscode.Position(next.range.end[0], next.range.end[1])
		);
		decorationDeleteType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(255, 60, 60, 0.18)',
			border: '1px solid rgba(255, 60, 60, 0.35)',
			textDecoration: 'line-through'
		});
		editor.setDecorations(decorationDeleteType, [{ range }]);
	} else if (next.kind === 'editReplace') {
		const range = new vscode.Range(
			new vscode.Position(next.range.start[0], next.range.start[1]),
			new vscode.Position(next.range.end[0], next.range.end[1])
		);
		decorationReplaceType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(255,165,0,0.15)',
			border: '1px dashed rgba(255,165,0,0.45)',
			color: new vscode.ThemeColor('disabledForeground'),
			textDecoration: 'line-through'
		});
		editor.setDecorations(decorationReplaceType, [{ range }]);

		const fullBlock = next.text;
		
		const cssContent = fullBlock
			.replace(/"/g, '\\"')
			.replace(/\r?\n/g, '\\A '); 

		const anchorLine = range.start.line;
		const anchorPos = new vscode.Position(anchorLine, Number.MAX_VALUE);
		const margin = getDynamicMargin(editor, anchorLine, fullBlock);

		decorationReplaceBlockType = vscode.window.createTextEditorDecorationType({
			after: {
				contentText: '',
				color: new vscode.ThemeColor('charts.purple'),
				backgroundColor: new vscode.ThemeColor('editor.background'),
				fontStyle: 'italic',
				fontWeight: '600',
				margin: `0 0 0 ${margin}`,
				textDecoration: `none; display: inline-block; white-space: pre; content: "${cssContent}"; border: 1px solid var(--vscode-charts-purple); padding: 4px; border-radius: 4px; box-shadow: 0 4px 8px rgba(0,0,0,0.25); pointer-events: none; position: relative; z-index: 100; vertical-align: top;`
			}
		});
		editor.setDecorations(decorationReplaceBlockType, [{ range: new vscode.Range(anchorPos, anchorPos) }]);
	}

	previewVisible = true;
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, true);
	currentAction = action;
}

function hidePreviewUI(suppress?: boolean): void {
	disposePreviewDecorations();
	previewVisible = false;
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
	if (suppress) {
		suppressAutoPreview = true;
	}
}

/**
 * Schedule a model preview refresh, coalescing rapid editor events and
 * throttling how often we actually talk to the model.
 */
function schedulePredictionRefresh(debounce: boolean, userRequested: boolean): void {
	if (!suggestionsEnabled) {
		return;
	}
	if (!userRequested && suppressAutoPreview) {
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		hidePreviewUI();
		return;
	}

	if (!userRequested) {
		if (!vscode.window.state.focused) {
			hidePreviewUI();
			return;
		}
		if (editor.document.getText().length === 0) {
			hidePreviewUI();
			return;
		}
	}

	const now = Date.now();
	const id = ++nextQueuedPredictionId;

	let delay = 0;
	if (debounce) {
		delay = Math.max(delay, PREDICTION_DEBOUNCE_MS);
	}
	if (lastPredictionTimestamp !== null && lastPredictionTimestamp !== undefined) {
		const elapsed = now - lastPredictionTimestamp;
		if (elapsed < PREDICTION_THROTTLE_MS) {
			delay = Math.max(delay, PREDICTION_THROTTLE_MS - elapsed);
		}
	}

	const timer = setTimeout(() => {
		if (cancelledPredictionIds.has(id)) {
			cancelledPredictionIds.delete(id);
			return;
		}

		lastPredictionTimestamp = Date.now();
		pendingPredictions = pendingPredictions.filter(p => p.id !== id);

		void autoShowNextAction();
	}, delay);

	pendingPredictions.push({ id, timer });

	if (pendingPredictions.length > 2) {
		const oldest = pendingPredictions.shift();
		if (oldest) {
			cancelledPredictionIds.add(oldest.id);
			clearTimeout(oldest.timer);
		}
	}
}

async function autoShowNextAction(): Promise<void> {
	if (suppressAutoPreview) { return; }
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	try {
		currentAbortController?.abort();
		const controller = new AbortController();
		currentAbortController = controller;
		const requestId = ++latestRequestId;
		const next = await requestModelActions(editor, controller.signal);
		if (requestId !== latestRequestId) { return; }
		if (next) { showPreviewUI(next); } else { hidePreviewUI(); }
	} catch (err) {
		const e = err as any;
		const isAbort = e?.name === 'AbortError' || /aborted/i.test(String(e?.message ?? ''));
		if (isAbort) { return; }
		hidePreviewUI();
	}
}

// -------------------- SGLang Client (simple test) --------------------
async function callSGLangChat(): Promise<void> {
	const cfg = getConfig();
	const headers: any = {
		'Content-Type': 'application/json'
	};


	const requestBody: any = {
		model: cfg.modelName,
		messages: [
			{ role: 'user', content: 'What is the capital of France?' }
		]
	};
	requestBody.temperature = 0.7;
	requestBody.top_p = 0.8;
	requestBody.top_k = 20;
	requestBody.min_p = 0;
	requestBody.chat_template_kwargs = {
		enable_thinking: false
	};
	const postData = JSON.stringify(requestBody);
	headers['Content-Length'] = Buffer.byteLength(postData);

	const options = {
		hostname: cfg.hostname,
		port: cfg.port,
		path: cfg.basePath,
		method: 'POST',
		headers
	};


	try {
		const json = await new Promise<any>((resolve, reject) => {
			const req = http.request(options, (res: http.IncomingMessage) => {
				let data = '';
				res.on('data', (chunk: Buffer) => {
					data += chunk.toString();
				});
				res.on('end', () => {
					try {
						resolve(JSON.parse(data));
					} catch (err) {
						reject(new Error(`Failed to parse response: ${err instanceof Error ? err.message : String(err)}`));
					}
				});
			});

			req.on('error', (err: Error) => {
				reject(err);
			});

			req.write(postData);
			req.end();
		});

		vscode.window.showInformationMessage(`Response: ${JSON.stringify(json, null, 2)}`);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Request failed: ${errorMessage}`);
	}
}

// -------------------- Model-planned Actions --------------------
async function requestModelActions(editor: vscode.TextEditor, signal?: AbortSignal): Promise<PlannedAction> {
	const cfg = getConfig();
	const headers: any = {
		'Content-Type': 'application/json'
	};

	const doc = editor.document;

	// FIXME (f.srambical): This should be the system prompt that was used during serialization.
	const systemPrompt = [
		'You are a helpful assistant that can interact multiple times with a computer shell to solve programming tasks.',
		'Your goal is to predict the next assistant action based on the conversation history and context provided.',
		'Your response must contain exactly ONE bash code block with ONE command (or commands connected with && or ||).',
		'',
		'Format your response as shown in <format_example>.',
		'',
		'<format_example>',
		'```bash',
		'your_command_here',
		'```',
		'</format_example>',
		'',
		'Failure to follow these rules will cause your response to be rejected.',
		'',
		'=== EDIT COMMAND FORMAT (IMPORTANT) ===',
		'When you want to EDIT a file, you MUST encode the edit using line-based sed commands in ONE of the following forms,',
		'and you MUST NOT use substitution commands like "Ns/old/new/g".',
		'',
		'Assume all line numbers are 1-based and paths are absolute.',
		'Allowed edit encodings (choose exactly one per response):',
		'',
		'1) Replace a contiguous block of lines:',
		"   sed -i 'START,ENDc\\",
		'NEW_LINE_1',
		'NEW_LINE_2',
		"...",
		"' /abs/path/to/file && cat -n /abs/path/to/file | sed -n 'VSTART,VENDp'",
		'',
		'2) Delete a contiguous block of lines:',
		"   sed -i 'START,ENDd' /abs/path/to/file && cat -n /abs/path/to/file | sed -n 'VSTART,VENDp'",
		'',
		'3) Insert new lines BEFORE a given line:',
		"   sed -i 'STARTi\\",
		'NEW_LINE_1',
		'NEW_LINE_2',
		"...",
		"' /abs/path/to/file && cat -n /abs/path/to/file | sed -n 'VSTART,VENDp'",
		'',
		'4) Append new lines at the END of the file:',
		"   sed -i '$a\\",
		'NEW_LINE_1',
		'NEW_LINE_2',
		"...",
		"' /abs/path/to/file && cat -n /abs/path/to/file | sed -n 'VSTART,VENDp'",
		'',
		'Where VSTART and VEND specify a small viewport around the edited region.',
		'',
		'Do NOT emit commands like "3s/print/print()/g" or any other "s/old/new/" style sed substitution; instead,',
		'always rewrite the affected lines using one of the line-based forms above.',
		'',
		'When you are NOT editing files (e.g., running tests, git commands, tools, etc.), you may emit arbitrary bash commands.'
	].join('\n');

	const accumulatedMessages = conversationManager.finalizeForModel();
	
	const conversationMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
		{ role: 'system', content: systemPrompt },
	];
	
	for (const msg of accumulatedMessages) {
		const role = msg.from === 'User' ? 'user' : 'assistant';
		conversationMessages.push({ role, content: msg.value });
	}

	const requestBody: any = {
		model: cfg.modelName,
		messages: conversationMessages
	};
	requestBody.temperature = 0.7;
	requestBody.top_p = 0.8;
	requestBody.top_k = 20;
	requestBody.min_p = 0;
	requestBody.logprobs = true;
	requestBody.chat_template_kwargs = {
		enable_thinking: false
	};

	const postData = JSON.stringify(requestBody);
	headers['Content-Length'] = Buffer.byteLength(postData);

	const options: any = {
		hostname: cfg.hostname,
		port: cfg.port,
		path: cfg.basePath,
		method: 'POST',
		headers
	};
	if (signal) {
		options.signal = signal;
	}

	const json = await new Promise<any>((resolve, reject) => {
		const req = http.request(options, (res: http.IncomingMessage) => {
			let data = '';
			res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
			res.on('end', () => {
				try {
					resolve(JSON.parse(data));
				} catch (err) {
					reject(new Error(`Failed to parse response: ${err instanceof Error ? err.message : String(err)}`));
				}
			});
		});
		req.on('error', (err: Error) => reject(err));
		req.write(postData);
		req.end();
	});

	const avgLogprob = calculateAverageLogprob(json);
	if (avgLogprob < MIN_AVG_LOGPROB) {
		return undefined as any; // Low confidence, silently skip suggestion
	}

	const content = extractChatContent(json);
	if (typeof content !== 'string' || content.trim().length === 0) {
		throw new Error('Empty model content');
	}
	const action = parsePlannedAction(content, doc);
	if (!action) {
		throw new Error('No valid action parsed from model output');
	}
	return action;
}

function extractChatContent(json: any): string | undefined {
	try {
		if (json && Array.isArray(json.choices) && json.choices[0]) {
			const choice = json.choices[0];
			if (choice.message && typeof choice.message.content === 'string') {
				return choice.message.content;
			}
			if (typeof choice.text === 'string') {
				return choice.text;
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Calculate average logprob per token from the API response.
 * Returns the mean of logprobs across all tokens (negative value, closer to 0 = more confident).
 * Returns -Infinity if logprobs are not available.
 */
function calculateAverageLogprob(json: any): number {
	const logprobs = json.choices[0]?.logprobs;
	const sum = logprobs.content.reduce((s: number, t: any) => s + t.logprob, 0);
	return sum / logprobs.content.length;
}

function parsePlannedAction(raw: string, doc?: vscode.TextDocument): PlannedAction | undefined {
	const command = extractBashCommand(raw);
	if (!command) {
		return undefined;
	}
	const normalized = command.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
	if (!normalized) {
		return undefined;
	}
	if (doc) {
		const editAction = parseEditFromSedCommand(normalized, doc);
		if (editAction) {
			return editAction;
		}
		const viewportAction = parseViewportFromCatCommand(normalized, doc);
		if (viewportAction) {
			return viewportAction;
		}
	}
	return { kind: 'terminalSendText', text: normalized };
}

/**
 * Parse a sed-based edit command of the form emitted by the NeMo serializer into a VS Code edit action.
 *
 * Supported patterns (1-based line numbers, mirroring serialization_utils.py):
 *   sed -i 'START,ENDc\n<replacement...>' <file>     -> editReplace
 *   sed -i 'START,ENDd' <file>                      -> editDelete
 *   sed -i 'STARTi\n<insert...>' <file>             -> editInsert (before START)
 *   sed -i '$a\n<append...>' <file>                 -> editInsert (append at EOF)
 *
 * If the command does not match these patterns, returns undefined.
 */
function parseEditFromSedCommand(command: string, doc: vscode.TextDocument): PlannedAction | undefined {
	// Only consider the first command before && / ||, since cat -n etc. are for viewport only.
	const main = command.split(/&&|\|\|/)[0]?.trim() ?? '';
	if (!main) {
		return undefined;
	}

	// Match: sed -i '<script>' <file>
	const sedMatch = main.match(/sed\s+-i\s+'([\s\S]*?)'\s+([^\s&|]+)\s*$/);
	if (!sedMatch) {
		return undefined;
	}
	const script = sedMatch[1] ?? '';
	const targetFile = sedMatch[2] ?? '';
	const activePath = doc.uri.fsPath;
	if (targetFile !== activePath) {
		return undefined;
	}

	// Delete: "START,ENDd"
	const deleteMatch = script.match(/^(\d+),(\d+)d$/);
	if (deleteMatch) {
		const startLine1 = Number(deleteMatch[1]);
		const endLine1 = Number(deleteMatch[2]);
		if (!Number.isFinite(startLine1) || !Number.isFinite(endLine1)) {
			return undefined;
		}
		const startLine0 = Math.max(0, startLine1 - 1);
		const endLine0 = Math.max(0, endLine1 - 1);

		let endPosLine = endLine0 + 1;
		let endPosChar = 0;
		if (endPosLine >= doc.lineCount) {
			endPosLine = doc.lineCount - 1;
			endPosChar = doc.lineAt(endPosLine).range.end.character;
		}
		return {
			kind: 'editDelete',
			range: {
				start: [startLine0, 0],
				end: [endPosLine, endPosChar],
			},
		};
	}

	// Replace: "START,ENDc\newline<payload...>"
	const replaceMatch = script.match(/^(\d+),(\d+)c\\\n([\s\S]*)$/);
	if (replaceMatch) {
		const startLine1 = Number(replaceMatch[1]);
		const endLine1 = Number(replaceMatch[2]);
		let payload = replaceMatch[3] ?? '';
		if (!Number.isFinite(startLine1) || !Number.isFinite(endLine1)) {
			return undefined;
		}
		payload = payload.replace(/'\"'\"'/g, "'");
		// Convert escape sequences to actual characters
		payload = payload.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
		const startLine0 = Math.max(0, startLine1 - 1);
		const endLine0 = Math.max(0, endLine1 - 1);
		const startPos: [number, number] = [startLine0, 0];

		let endPosLine = endLine0 + 1;
		let endPosChar = 0;
		if (endPosLine >= doc.lineCount) {
			endPosLine = doc.lineCount - 1;
			endPosChar = doc.lineAt(endPosLine).range.end.character;
		}

		const text = payload.endsWith('\n') ? payload : payload + '\n';
		return {
			kind: 'editReplace',
			range: { start: startPos, end: [endPosLine, endPosChar] },
			text,
		};
	}

	const insertMatch = script.match(/^(\d+)i\\\n([\s\S]*)$/);
	if (insertMatch) {
		const line1 = Number(insertMatch[1]);
		let payload = insertMatch[2] ?? '';
		if (!Number.isFinite(line1)) {
			return undefined;
		}
		payload = payload.replace(/'\"'\"'/g, "'");
		// Convert escape sequences to actual characters
		payload = payload.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
		const insertLine0 = Math.max(0, line1 - 1);
		const position: [number, number] = [insertLine0, 0];
		const text = payload.endsWith('\n') ? payload : payload + '\n';
		return {
			kind: 'editInsert',
			position,
			text,
		};
	}

	const appendMatch = script.match(/^\$a\\\n([\s\S]*)$/);
	if (appendMatch) {
		let payload = appendMatch[1] ?? '';
		payload = payload.replace(/'\"'\"'/g, "'");
		// Convert escape sequences to actual characters
		payload = payload.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
		const insertLine0 = doc.lineCount;
		const position: [number, number] = [insertLine0, 0];
		const needsLeadingNewline = doc.lineCount > 0;
		const base = payload.endsWith('\n') ? payload : payload + '\n';
		const text = needsLeadingNewline ? '\n' + base : base;
		return {
			kind: 'editInsert',
			position,
			text,
		};
	}

	return undefined;
}

/**
 * Parse viewport / selection commands of the form:
 *   cat -n <file> | sed -n 'START,ENDp'
 *
 * into a lightweight VS Code selection move (setSelections). This mirrors how
 * selection and viewport events are serialized in serialization_utils.py.
 */
function parseViewportFromCatCommand(command: string, doc: vscode.TextDocument): PlannedAction | undefined {
	const main = command.split(/&&|\|\|/)[0]?.trim() ?? '';
	if (!main) {
		return undefined;
	}

	// Simple file-open: cat -n <file>
	const simpleCatMatch = main.match(/^cat\s+-n\s+([^\s|]+)\s*$/);
	if (simpleCatMatch) {
		const targetFile = simpleCatMatch[1] ?? '';
		if (targetFile !== doc.uri.fsPath) {
			return undefined;
		}
		// Ensure the active document is visible; rely on existing editor to handle this.
		return { kind: 'showTextDocument' };
	}

	// Viewport slice: cat -n <file> | sed -n 'START,ENDp'
	const viewportMatch = main.match(/^cat\s+-n\s+([^\s|]+)\s*\|\s*sed\s+-n\s+'(\d+),(\d+)p'\s*$/);
	if (!viewportMatch) {
		return undefined;
	}

	const targetFile = viewportMatch[1] ?? '';
	const startStr = viewportMatch[2] ?? '';
	const endStr = viewportMatch[3] ?? '';

	if (targetFile !== doc.uri.fsPath) {
		return undefined;
	}

	const startLine1 = Number(startStr);
	const endLine1 = Number(endStr);
	if (!Number.isFinite(startLine1) || !Number.isFinite(endLine1)) {
		return undefined;
	}

	// Place the cursor in the middle of the viewport (1-based to 0-based).
	const center1 = Math.floor((startLine1 + endLine1) / 2);
	const center0 = Math.max(0, center1 - 1);
	const lastLine = Math.max(0, doc.lineCount - 1);
	const line = Math.min(center0, lastLine);
	const endChar = doc.lineAt(line).range.end.character;

	return {
		kind: 'setSelections',
		selections: [
			{
				start: [line, endChar],
				end: [line, endChar],
			},
		],
	};
}

function extractBashCommand(raw: string): string | undefined {
	if (!raw) {
		return undefined;
	}
	const trimmed = raw.trim();
	const fenceMatch = trimmed.match(/```(?:bash)?\s*([\s\S]*?)```/i);
	if (fenceMatch && fenceMatch[1]) {
		return fenceMatch[1];
	}
	// Fallback: treat entire response as the command
	return trimmed.length > 0 ? trimmed : undefined;
}