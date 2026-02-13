import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Buffer } from 'buffer';
import { SweepConversationStateManager } from '@crowd-pilot/serializer';
import { PreviewManager, Action } from './preview';
import { parsedSweepEditToAction, SweepParsedEdit } from './utils/sweepAction';
import { advancePositionByText, dropSingleTrailingNewline } from './utils/cursor';
import { diffChars } from './utils/diff';

// -------------------- Preference Data Collection --------------------

type PreferenceOutcome = 'accepted' | 'rejected' | 'ignored';
type PreferenceOutcomeSource =
	| 'tab_accept'
	| 'quickpick_accept'
	| 'escape_dismiss'
	| 'quickpick_dismiss'
	| 'auto_ignored';

interface PreferencePrompt {
	model: string;
	messages: Array<{ role: string; content: string }>;
	temperature: number;
	top_p: number;
	top_k: number;
	min_p: number;
	logprobs: boolean;
	chat_template_kwargs: {
		enable_thinking: boolean;
	};
}

interface PreferenceFileSelection {
	start: [number, number];
	end: [number, number];
}

interface PreferenceFileState {
	uri: string;
	fsPath: string;
	languageId: string;
	version: number;
	text: string;
	selections: PreferenceFileSelection[];
}

interface PreferenceSample {
	type: 'preference_sample';
	sampleId: string;
	timestamp: number;
	prompt: PreferencePrompt;
	context: Array<{ role: string; content: string }>;
	fileState: PreferenceFileState;
	completion: {
		rawModelOutput: string;
		parsedAction: Action | null;
		avgLogprob: number;
	};
	outcome: PreferenceOutcome | null;
	outcomeTimestamp: number | null;
	outcomeSource: PreferenceOutcomeSource | null;
	modelName: string;
}

interface PendingPreferenceSample {
	sample: PreferenceSample;
	shownAt: number;
}

type RejectFollowupStopReason = 'pause' | 'another_action';
type RejectFollowupAnotherActionType = 'cursor_move' | 'file_switch' | 'terminal_focus' | 'terminal_command';

interface RejectFollowupChange {
	rangeOffset: number;
	rangeLength: number;
	text: string;
}

interface RejectFollowupEditEvent {
	ts: number;
	docVersion: number;
	contentChanges: RejectFollowupChange[];
}

interface RejectFollowupSample {
	type: 'reject_followup';
	sampleId: string;
	rejectedAt: number;
	firstEditAt: number;
	endedAt: number;
	stopReason: RejectFollowupStopReason;
	anotherActionType: RejectFollowupAnotherActionType | null;
	docUri: string;
	edits: RejectFollowupEditEvent[];
	stats: {
		editEventCount: number;
		contentChangeCount: number;
		charsInserted: number;
		charsDeleted: number;
	};
}

type AcceptFollowupStopReason = 'pause' | 'another_action';
type AcceptFollowupAnotherActionType =
	| 'cursor_far'
	| 'file_switch'
	| 'terminal_focus'
	| 'terminal_command'
	| 'new_suggestion';
type AcceptFollowupRelationship = 'none' | 'refinement' | 'continuation' | 'mixed';

interface AcceptFollowupSample {
	type: 'accept_followup';
	sampleId: string;
	acceptedAt: number;
	firstEditAt: number | null;
	endedAt: number;
	stopReason: AcceptFollowupStopReason;
	anotherActionType: AcceptFollowupAnotherActionType | null;
	docUri: string;
	initialRegion: {
		startLine: number;
		endLine: number;
	};
	finalRegion: {
		startLine: number;
		endLine: number;
	};
	baseFileState: PreferenceFileState;
	finalFileState: PreferenceFileState;
	edits: RejectFollowupEditEvent[];
	relationship: AcceptFollowupRelationship;
	stats: {
		editEventCount: number;
		contentChangeCount: number;
		charsInserted: number;
		charsDeleted: number;
	};
	metrics: {
		acceptedRegionCharEditDistance: number | null;
		fullFileCharEditDistance: number | null;
	};
}

type ArmedRejectCaptureState = {
	phase: 'armed';
	sampleId: string;
	rejectedAt: number;
	originDocUri: string | null;
	cursorMoveTimer: NodeJS.Timeout | null;
};

type ActiveRejectCaptureState = {
	phase: 'active';
	sampleId: string;
	rejectedAt: number;
	docUri: string;
	firstEditAt: number;
	edits: RejectFollowupEditEvent[];
	inactivityTimer: NodeJS.Timeout | null;
	pendingSelectionSkipVersion: number | null;
	cursorMoveTimer: NodeJS.Timeout | null;
};

type RejectCaptureState = ArmedRejectCaptureState | ActiveRejectCaptureState;

type ActiveAcceptCaptureState = {
	sampleId: string;
	acceptedAt: number;
	docUri: string;
	baseFileState: PreferenceFileState;
	initialRegionStartLine: number;
	initialRegionEndLine: number;
	regionStartLine: number;
	regionEndLine: number;
	edits: RejectFollowupEditEvent[];
	firstEditAt: number | null;
	inactivityTimer: NodeJS.Timeout | null;
	pendingSelectionSkipVersion: number | null;
	touchedRegionChangeCount: number;
	outsideRegionChangeCount: number;
};

interface IndexedPreferenceLogFile {
	index: number;
	name: string;
	filePath: string;
}

interface PreferenceLogTarget {
	basePath: string;
	dir: string;
	stem: string;
	ext: string;
}

type PreferenceLogState = {
	stateKey: string;
	currentIndex: number;
	currentLineCount: number;
};

let pendingPreferenceSample: PendingPreferenceSample | null = null;
let rejectCaptureState: RejectCaptureState | null = null;
let acceptCaptureState: ActiveAcceptCaptureState | null = null;
const REJECT_CAPTURE_CURSOR_GRACE_MS = 75;
const PREFERENCE_LOG_INDEX_PADDING = 6;
const PREFERENCE_UPLOAD_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PREFERENCE_LOG_MAX_LINES_PER_FILE = 500;
const PREFERENCE_UPLOAD_API_GATEWAY_URL = process.env.CROWD_PILOT_API_GATEWAY_URL || '';

let preferenceLogState: PreferenceLogState | null = null;
let preferenceLogQueue: Promise<void> = Promise.resolve();
let preferenceUploadIntervalId: NodeJS.Timeout | null = null;
let preferenceUploadExtensionVersion = '0.0.0';
let preferenceUploadUserId = '';

function getPreferenceLogPath(): string {
	const cfg = getConfig();
	if (cfg.preferenceLogPath) {
		return cfg.preferenceLogPath;
	}
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		return path.join(workspaceFolders[0].uri.fsPath, '.crowd-pilot-preferences.jsonl');
	}
	throw new Error("No preference log path found.");
}

function getPreferenceLogDir(): string {
	return path.dirname(getPreferenceLogPath());
}

function getPreferenceLogTarget(): PreferenceLogTarget {
	const basePath = getPreferenceLogPath();
	const dir = path.dirname(basePath);
	const parsed = path.parse(basePath);
	const ext = parsed.ext || '.jsonl';
	return {
		basePath,
		dir,
		stem: parsed.name,
		ext,
	};
}

function getPreferenceLogMaxLinesPerFile(): number {
	return DEFAULT_PREFERENCE_LOG_MAX_LINES_PER_FILE;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatPreferenceLogIndex(index: number): string {
	return String(index).padStart(PREFERENCE_LOG_INDEX_PADDING, '0');
}

function preferenceLogFilePathForIndex(target: PreferenceLogTarget, index: number): string {
	const fileName = `${target.stem}.${formatPreferenceLogIndex(index)}${target.ext}`;
	return path.join(target.dir, fileName);
}

function parseIndexedPreferenceLogName(target: PreferenceLogTarget, fileName: string): number | null {
	const pattern = new RegExp(`^${escapeRegex(target.stem)}\\.(\\d+)${escapeRegex(target.ext)}$`);
	const match = pattern.exec(fileName);
	if (!match) {
		return null;
	}
	const index = Number.parseInt(match[1], 10);
	return Number.isFinite(index) ? index : null;
}

async function listIndexedPreferenceLogFiles(target: PreferenceLogTarget): Promise<IndexedPreferenceLogFile[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(target.dir, { withFileTypes: true });
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw err;
	}
	const files: IndexedPreferenceLogFile[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}
		const index = parseIndexedPreferenceLogName(target, entry.name);
		if (index === null) {
			continue;
		}
		files.push({
			index,
			name: entry.name,
			filePath: path.join(target.dir, entry.name),
		});
	}
	files.sort((a, b) => a.index - b.index);
	return files;
}

function countJsonlLines(contents: string): number {
	if (contents.length === 0) {
		return 0;
	}
	return contents.split('\n').filter((line) => line.length > 0).length;
}

async function ensurePreferenceLogState(): Promise<void> {
	const target = getPreferenceLogTarget();
	const maxLines = getPreferenceLogMaxLinesPerFile();
	const stateKey = `${target.basePath}::${maxLines}`;
	if (preferenceLogState?.stateKey === stateKey) {
		return;
	}

	await fs.promises.mkdir(target.dir, { recursive: true });

	const indexedFiles = await listIndexedPreferenceLogFiles(target);
	if (indexedFiles.length === 0) {
		preferenceLogState = {
			stateKey,
			currentIndex: 1,
			currentLineCount: 0,
		};
		return;
	}

	const latestFile = indexedFiles[indexedFiles.length - 1];
	let currentLineCount = 0;
	try {
		const contents = await fs.promises.readFile(latestFile.filePath, 'utf8');
		currentLineCount = countJsonlLines(contents);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}

	if (currentLineCount >= maxLines) {
		preferenceLogState = {
			stateKey,
			currentIndex: latestFile.index + 1,
			currentLineCount: 0,
		};
		return;
	}

	preferenceLogState = {
		stateKey,
		currentIndex: latestFile.index,
		currentLineCount,
	};
}

async function appendPreferenceLogLine(line: string): Promise<void> {
	await ensurePreferenceLogState();
	if (!preferenceLogState) {
		return;
	}
	const maxLines = getPreferenceLogMaxLinesPerFile();
	if (preferenceLogState.currentLineCount >= maxLines) {
		preferenceLogState.currentIndex += 1;
		preferenceLogState.currentLineCount = 0;
	}
	const target = getPreferenceLogTarget();
	const filePath = preferenceLogFilePathForIndex(target, preferenceLogState.currentIndex);
	await fs.promises.appendFile(filePath, line, 'utf8');
	preferenceLogState.currentLineCount += 1;
}

function enqueuePreferenceLogTask(task: () => Promise<void>): Promise<void> {
	const run = preferenceLogQueue.then(task);
	preferenceLogQueue = run.catch((err) => {
		console.error('[crowd-pilot] Preference log task failed:', err);
	});
	return run;
}

function getPreferenceUploadApiUrl(): string {
	return PREFERENCE_UPLOAD_API_GATEWAY_URL.trim();
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function uploadPreferenceLogFile(fileName: string, contents: string): Promise<boolean> {
	const uploadApiUrl = getPreferenceUploadApiUrl();
	if (!uploadApiUrl) {
		console.log('[crowd-pilot] Preference upload skipped: no upload API URL configured.');
		return false;
	}
	try {
		const presignResponse = await fetchWithTimeout(uploadApiUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				fileName,
				version: preferenceUploadExtensionVersion,
				userId: preferenceUploadUserId,
			}),
		}, 10_000);
		if (!presignResponse.ok) {
			const body = await presignResponse.text();
			throw new Error(`Presign request failed: ${presignResponse.status} ${body}`);
		}
		const payload = await presignResponse.json() as { uploadUrl?: string };
		if (!payload.uploadUrl || typeof payload.uploadUrl !== 'string') {
			throw new Error('Invalid presign response: missing uploadUrl');
		}
		const uploadResponse = await fetchWithTimeout(payload.uploadUrl, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/x-ndjson',
			},
			body: Buffer.from(contents, 'utf8'),
		}, 60_000);
		if (!uploadResponse.ok) {
			const body = await uploadResponse.text();
			throw new Error(`Upload failed: ${uploadResponse.status} ${body}`);
		}
		console.log(`[crowd-pilot] Uploaded preference log file ${fileName}`);
		return true;
	} catch (err) {
		console.error(`[crowd-pilot] Failed to upload preference log file ${fileName}:`, err);
		return false;
	}
}

async function uploadAllLocalPreferenceLogs(): Promise<void> {
	const cfg = getConfig();
	if (!cfg.enablePreferenceUpload) {
		return;
	}
	const uploadApiUrl = getPreferenceUploadApiUrl();
	if (!uploadApiUrl) {
		return;
	}

	await ensurePreferenceLogState();
	const target = getPreferenceLogTarget();
	const indexedFiles = await listIndexedPreferenceLogFiles(target);
	if (indexedFiles.length === 0) {
		return;
	}

	for (const file of indexedFiles) {
		let contents = '';
		try {
			contents = await fs.promises.readFile(file.filePath, 'utf8');
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				continue;
			}
			throw err;
		}

		if (countJsonlLines(contents) === 0) {
			await fs.promises.unlink(file.filePath).catch(() => undefined);
			if (preferenceLogState && preferenceLogState.currentIndex === file.index) {
				preferenceLogState.currentIndex += 1;
				preferenceLogState.currentLineCount = 0;
			}
			continue;
		}

		const uploaded = await uploadPreferenceLogFile(file.name, contents);
		if (!uploaded) {
			break;
		}

		await fs.promises.unlink(file.filePath).catch(() => undefined);
		if (preferenceLogState && preferenceLogState.currentIndex === file.index) {
			preferenceLogState.currentIndex += 1;
			preferenceLogState.currentLineCount = 0;
		}
	}
}

function startPreferenceUploadInterval(): void {
	stopPreferenceUploadInterval();
	preferenceUploadIntervalId = setInterval(() => {
		void enqueuePreferenceLogTask(uploadAllLocalPreferenceLogs);
	}, PREFERENCE_UPLOAD_INTERVAL_MS);
}

function stopPreferenceUploadInterval(): void {
	if (preferenceUploadIntervalId) {
		clearInterval(preferenceUploadIntervalId);
		preferenceUploadIntervalId = null;
	}
}

function initializePreferenceUploadIdentity(context: vscode.ExtensionContext): void {
	const rawVersion = context.extension.packageJSON.version;
	preferenceUploadExtensionVersion = typeof rawVersion === 'string'
		? rawVersion
		: '0.0.0';

	const machineId = vscode.env.machineId || 'unknown-machine';
	const userName = process.env.USER || process.env.USERNAME || 'coder';
	const plainUserId = `${machineId}-${userName}`;
	preferenceUploadUserId = plainUserId;
	void context.globalState.update('crowdPilot.preferenceUploadUserId', plainUserId);
}

async function getLatestIndexedPreferenceLogPath(): Promise<string | null> {
	const target = getPreferenceLogTarget();
	const files = await listIndexedPreferenceLogFiles(target);
	if (files.length === 0) {
		return null;
	}
	return files[files.length - 1].filePath;
}

function createModelLogId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function writeModelLog(id: string, contents: string, append: boolean): Promise<void> {
	const cfg = getConfig();
	if (!cfg.enableModelLogging) {
		return;
	}
	const baseDir = getPreferenceLogDir();
	const dir = path.join(baseDir, 'model-logs');
	await fs.promises.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${id}.txt`);
	if (append) {
		await fs.promises.appendFile(filePath, contents, 'utf8');
	} else {
		await fs.promises.writeFile(filePath, contents, 'utf8');
	}
}

async function logModelPrompt(id: string, prompt: string): Promise<void> {
	const contents = `=== Prompt ===\n${prompt}\n\n`;
	await writeModelLog(id, contents, false);
}

async function logModelResponse(id: string, raw: string): Promise<void> {
	const contents = `=== Response ===\n${raw}\n`;
	await writeModelLog(id, contents, true);
}

function appendPreferenceLogRecord(record: unknown, successMessage: string): void {
	const cfg = getConfig();
	if (!cfg.enablePreferenceLogging) {
		console.log('[crowd-pilot] Preference logging disabled, skipping record');
		return;
	}
	const line = JSON.stringify(record) + '\n';
	void enqueuePreferenceLogTask(async () => {
		await appendPreferenceLogLine(line);
		console.log(successMessage);
	});
}

/**
 * Log a preference sample to the JSONL file.
 * Each line is a complete JSON object for easy streaming/parsing.
 */
function logPreferenceSample(sample: PreferenceSample): void {
	appendPreferenceLogRecord(sample, `[crowd-pilot] Logged preference sample, outcome: (${sample.outcome})`);
}

function logRejectFollowupSample(sample: RejectFollowupSample): void {
	appendPreferenceLogRecord(sample, `[crowd-pilot] Logged reject followup sample for ${sample.sampleId}`);
}

function logAcceptFollowupSample(sample: AcceptFollowupSample): void {
	appendPreferenceLogRecord(sample, `[crowd-pilot] Logged accept followup sample for ${sample.sampleId}`);
}

function captureEditorFileState(editor: vscode.TextEditor): PreferenceFileState {
	const doc = editor.document;
	return {
		uri: doc.uri.toString(),
		fsPath: doc.uri.fsPath,
		languageId: doc.languageId,
		version: doc.version,
		text: doc.getText(),
		selections: editor.selections.map((selection) => ({
			start: [selection.start.line, selection.start.character],
			end: [selection.end.line, selection.end.character],
		})),
	};
}

function captureFileStateByUri(docUri: string): PreferenceFileState | null {
	const doc = vscode.workspace.textDocuments.find((textDoc) => textDoc.uri.toString() === docUri);
	if (!doc) {
		return null;
	}
	const activeEditor = vscode.window.activeTextEditor;
	const selections = activeEditor?.document.uri.toString() === docUri
		? activeEditor.selections.map((selection) => ({
			start: [selection.start.line, selection.start.character] as [number, number],
			end: [selection.end.line, selection.end.character] as [number, number],
		}))
		: [];
	return {
		uri: doc.uri.toString(),
		fsPath: doc.uri.fsPath,
		languageId: doc.languageId,
		version: doc.version,
		text: doc.getText(),
		selections,
	};
}

/**
 * Create a new pending preference sample when showing a preview.
 * This captures all context needed for reward model training.
 */
function createPendingPreferenceSample(
	prompt: PreferencePrompt,
	conversationMessages: Array<{ role: string; content: string }>,
	fileState: PreferenceFileState,
	rawModelOutput: string,
	parsedAction: Action | null,
	avgLogprob: number,
	modelName: string
): void {
	const sample: PreferenceSample = {
		type: 'preference_sample',
		sampleId: createModelLogId(),
		timestamp: Date.now(),
		prompt,
		context: conversationMessages,
		fileState,
		completion: {
			rawModelOutput,
			parsedAction,
			avgLogprob,
		},
		outcome: null,
		outcomeTimestamp: null,
		outcomeSource: null,
		modelName,
	};

	pendingPreferenceSample = {
		sample,
		shownAt: Date.now(),
	};
}

/**
 * Record the outcome of the current pending sample and log it.
 */
function recordPreferenceOutcome(
	outcome: PreferenceOutcome,
	outcomeSource: PreferenceOutcomeSource
): { sampleId: string; outcomeTimestamp: number } | null {
	if (!pendingPreferenceSample) {
		return null;
	}

	const sample = pendingPreferenceSample.sample;
	const outcomeTimestamp = Date.now();
	sample.outcome = outcome;
	sample.outcomeTimestamp = outcomeTimestamp;
	sample.outcomeSource = outcomeSource;

	logPreferenceSample(sample);

	pendingPreferenceSample = null;
	return { sampleId: sample.sampleId, outcomeTimestamp };
}

/**
 * Mark any pending sample as ignored (user moved on without explicit accept/reject).
 */
function markPendingAsIgnored(): void {
	if (pendingPreferenceSample) {
		recordPreferenceOutcome('ignored', 'auto_ignored');
	}
}

function isEditAction(action: Action): action is Extract<Action, { kind: 'editInsert' | 'editReplace' | 'editDelete' }> {
	return action.kind === 'editInsert' || action.kind === 'editReplace' || action.kind === 'editDelete';
}

function countLogicalLines(text: string): number {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const withoutTrailingNewline = normalized.endsWith('\n')
		? normalized.slice(0, -1)
		: normalized;
	if (withoutTrailingNewline.length === 0) {
		return 0;
	}
	return withoutTrailingNewline.split('\n').length;
}

function clampLine(line: number, lineCount: number): number {
	if (lineCount <= 0) {
		return 0;
	}
	return Math.min(Math.max(line, 0), lineCount - 1);
}

function actionAcceptedLineRegion(action: Extract<Action, { kind: 'editInsert' | 'editReplace' | 'editDelete' }>, lineCount: number): {
	startLine: number;
	endLine: number;
} | null {
	if (action.kind === 'editInsert') {
		const insertedLineCount = countLogicalLines(action.text);
		if (insertedLineCount <= 0) {
			return null;
		}
		const startLine = clampLine(action.position[0], lineCount);
		const endLine = clampLine(startLine + insertedLineCount - 1, lineCount);
		return { startLine, endLine };
	}
	if (action.kind === 'editReplace') {
		const startLine = clampLine(action.range.start[0], lineCount);
		const insertedLineCount = countLogicalLines(action.text);
		const endLine = insertedLineCount > 0
			? clampLine(startLine + insertedLineCount - 1, lineCount)
			: startLine;
		return { startLine, endLine };
	}
	const startLine = clampLine(action.range.start[0], lineCount);
	return { startLine, endLine: startLine };
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
	return startA <= endB && startB <= endA;
}

function calculateFollowupStats(edits: RejectFollowupEditEvent[]): {
	editEventCount: number;
	contentChangeCount: number;
	charsInserted: number;
	charsDeleted: number;
} {
	let contentChangeCount = 0;
	let charsInserted = 0;
	let charsDeleted = 0;
	for (const edit of edits) {
		contentChangeCount += edit.contentChanges.length;
		for (const change of edit.contentChanges) {
			charsInserted += change.text.length;
			charsDeleted += change.rangeLength;
		}
	}
	return {
		editEventCount: edits.length,
		contentChangeCount,
		charsInserted,
		charsDeleted,
	};
}

function extractTextForLineRange(text: string, startLine: number, endLine: number): string {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const lines = normalized.split('\n');
	if (lines.length === 0) {
		return '';
	}
	const clampedStart = clampLine(startLine, lines.length);
	const clampedEnd = clampLine(endLine, lines.length);
	if (clampedEnd < clampedStart) {
		return '';
	}
	return lines.slice(clampedStart, clampedEnd + 1).join('\n');
}

function computeCharEditDistance(a: string, b: string): number | null {
	const maxProduct = 4_000_000;
	if (a.length * b.length > maxProduct) {
		return null;
	}
	const segments = diffChars(a, b);
	let distance = 0;
	for (const segment of segments) {
		if (segment.type === 'insert' || segment.type === 'delete') {
			distance += segment.value.length;
		}
	}
	return distance;
}

function clearRejectCaptureState(): void {
	if (rejectCaptureState?.cursorMoveTimer) {
		clearTimeout(rejectCaptureState.cursorMoveTimer);
	}
	if (rejectCaptureState?.phase === 'active' && rejectCaptureState.inactivityTimer) {
		clearTimeout(rejectCaptureState.inactivityTimer);
	}
	rejectCaptureState = null;
}

function armRejectCapture(sampleId: string, rejectedAt: number): void {
	clearRejectCaptureState();
	rejectCaptureState = {
		phase: 'armed',
		sampleId,
		rejectedAt,
		originDocUri: vscode.window.activeTextEditor?.document.uri.toString() ?? null,
		cursorMoveTimer: null,
	};
}

function resetRejectCaptureTimer(state: ActiveRejectCaptureState): void {
	if (state.inactivityTimer) {
		clearTimeout(state.inactivityTimer);
	}
	const rawPauseMs = getConfig().rejectFollowupPauseMs;
	const pauseMs = Number.isFinite(rawPauseMs) ? Math.max(0, Math.floor(rawPauseMs)) : 5000;
	state.inactivityTimer = setTimeout(() => {
		finalizeRejectCapture('pause', null);
	}, pauseMs);
}

function finalizeRejectCapture(
	stopReason: RejectFollowupStopReason,
	anotherActionType: RejectFollowupAnotherActionType | null
): void {
	if (!rejectCaptureState) {
		return;
	}
	if (rejectCaptureState.phase === 'armed') {
		clearRejectCaptureState();
		return;
	}
	const state = rejectCaptureState;
	clearRejectCaptureState();
	if (state.edits.length === 0) {
		return;
	}

	const followup: RejectFollowupSample = {
		type: 'reject_followup',
		sampleId: state.sampleId,
		rejectedAt: state.rejectedAt,
		firstEditAt: state.firstEditAt,
		endedAt: Date.now(),
		stopReason,
		anotherActionType,
		docUri: state.docUri,
		edits: state.edits,
		stats: calculateFollowupStats(state.edits),
	};
	logRejectFollowupSample(followup);
}

function stopRejectCaptureForAnotherAction(actionType: RejectFollowupAnotherActionType): void {
	if (!rejectCaptureState) {
		return;
	}
	if (rejectCaptureState.phase === 'armed') {
		clearRejectCaptureState();
		return;
	}
	finalizeRejectCapture('another_action', actionType);
}

function scheduleRejectCaptureCursorStop(): void {
	if (!rejectCaptureState) {
		return;
	}
	if (rejectCaptureState.cursorMoveTimer) {
		clearTimeout(rejectCaptureState.cursorMoveTimer);
	}
	rejectCaptureState.cursorMoveTimer = setTimeout(() => {
		if (!rejectCaptureState) {
			return;
		}
		stopRejectCaptureForAnotherAction('cursor_move');
	}, REJECT_CAPTURE_CURSOR_GRACE_MS);
}

function captureRejectFollowupEdit(e: vscode.TextDocumentChangeEvent): void {
	if (!rejectCaptureState || e.contentChanges.length === 0) {
		return;
	}

	if (rejectCaptureState.phase === 'armed') {
		if (rejectCaptureState.cursorMoveTimer) {
			clearTimeout(rejectCaptureState.cursorMoveTimer);
		}
		rejectCaptureState = {
			phase: 'active',
			sampleId: rejectCaptureState.sampleId,
			rejectedAt: rejectCaptureState.rejectedAt,
			docUri: e.document.uri.toString(),
			firstEditAt: Date.now(),
			edits: [],
			inactivityTimer: null,
			pendingSelectionSkipVersion: null,
			cursorMoveTimer: null,
		};
	}

	if (rejectCaptureState.phase !== 'active') {
		return;
	}

	if (rejectCaptureState.docUri !== e.document.uri.toString()) {
		stopRejectCaptureForAnotherAction('file_switch');
		return;
	}
	if (rejectCaptureState.cursorMoveTimer) {
		clearTimeout(rejectCaptureState.cursorMoveTimer);
		rejectCaptureState.cursorMoveTimer = null;
	}

	const editEvent: RejectFollowupEditEvent = {
		ts: Date.now(),
		docVersion: e.document.version,
		contentChanges: e.contentChanges.map((change) => ({
			rangeOffset: change.rangeOffset,
			rangeLength: change.rangeLength,
			text: change.text,
		})),
	};
	rejectCaptureState.edits.push(editEvent);
	rejectCaptureState.pendingSelectionSkipVersion = e.document.version;
	resetRejectCaptureTimer(rejectCaptureState);
}

function handleRejectCaptureSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
	if (!rejectCaptureState) {
		return;
	}

	const currentDocUri = e.textEditor.document.uri.toString();
	if (rejectCaptureState.phase === 'armed') {
		if (rejectCaptureState.originDocUri && currentDocUri !== rejectCaptureState.originDocUri) {
			stopRejectCaptureForAnotherAction('file_switch');
			return;
		}
		if (e.kind === vscode.TextEditorSelectionChangeKind.Mouse || e.kind === vscode.TextEditorSelectionChangeKind.Command) {
			stopRejectCaptureForAnotherAction('cursor_move');
			return;
		}
		scheduleRejectCaptureCursorStop();
		return;
	}

	if (currentDocUri !== rejectCaptureState.docUri) {
		stopRejectCaptureForAnotherAction('file_switch');
		return;
	}

	if (
		rejectCaptureState.pendingSelectionSkipVersion !== null
		&& e.textEditor.document.version === rejectCaptureState.pendingSelectionSkipVersion
	) {
		rejectCaptureState.pendingSelectionSkipVersion = null;
		return;
	}

	if (e.kind === vscode.TextEditorSelectionChangeKind.Mouse || e.kind === vscode.TextEditorSelectionChangeKind.Command) {
		stopRejectCaptureForAnotherAction('cursor_move');
		return;
	}
	scheduleRejectCaptureCursorStop();
}

function handleRejectCaptureEditorSwitch(editor: vscode.TextEditor | undefined): void {
	if (!rejectCaptureState) {
		return;
	}
	const nextUri = editor?.document.uri.toString() ?? null;
	if (rejectCaptureState.phase === 'armed') {
		if (rejectCaptureState.originDocUri && nextUri === rejectCaptureState.originDocUri) {
			return;
		}
		stopRejectCaptureForAnotherAction('file_switch');
		return;
	}
	if (nextUri !== rejectCaptureState.docUri) {
		stopRejectCaptureForAnotherAction('file_switch');
	}
}

function recordRejectAndArmCapture(source: 'escape_dismiss' | 'quickpick_dismiss'): void {
	const recorded = recordPreferenceOutcome('rejected', source);
	if (!recorded) {
		clearRejectCaptureState();
		return;
	}
	armRejectCapture(recorded.sampleId, recorded.outcomeTimestamp);
}

function clearAcceptCaptureState(): void {
	if (acceptCaptureState?.inactivityTimer) {
		clearTimeout(acceptCaptureState.inactivityTimer);
	}
	acceptCaptureState = null;
}

function resetAcceptCaptureTimer(): void {
	if (!acceptCaptureState) {
		return;
	}
	if (acceptCaptureState.inactivityTimer) {
		clearTimeout(acceptCaptureState.inactivityTimer);
	}
	const rawPauseMs = getConfig().acceptFollowupPauseMs;
	const pauseMs = Number.isFinite(rawPauseMs) ? Math.max(0, Math.floor(rawPauseMs)) : 5000;
	acceptCaptureState.inactivityTimer = setTimeout(() => {
		finalizeAcceptCapture('pause', null);
	}, pauseMs);
}

function classifyAcceptRelationship(state: ActiveAcceptCaptureState): AcceptFollowupRelationship {
	if (state.edits.length === 0) {
		return 'none';
	}
	if (state.touchedRegionChangeCount > 0 && state.outsideRegionChangeCount === 0) {
		return 'refinement';
	}
	if (state.outsideRegionChangeCount > 0 && state.touchedRegionChangeCount === 0) {
		return 'continuation';
	}
	return 'mixed';
}

function finalizeAcceptCapture(
	stopReason: AcceptFollowupStopReason,
	anotherActionType: AcceptFollowupAnotherActionType | null
): void {
	if (!acceptCaptureState) {
		return;
	}
	const state = acceptCaptureState;
	clearAcceptCaptureState();

	const finalFileState = captureFileStateByUri(state.docUri) ?? state.baseFileState;
	const baseRegionText = extractTextForLineRange(
		state.baseFileState.text,
		state.initialRegionStartLine,
		state.initialRegionEndLine
	);
	const finalRegionText = extractTextForLineRange(
		finalFileState.text,
		state.regionStartLine,
		state.regionEndLine
	);

	const followup: AcceptFollowupSample = {
		type: 'accept_followup',
		sampleId: state.sampleId,
		acceptedAt: state.acceptedAt,
		firstEditAt: state.firstEditAt,
		endedAt: Date.now(),
		stopReason,
		anotherActionType,
		docUri: state.docUri,
		initialRegion: {
			startLine: state.initialRegionStartLine,
			endLine: state.initialRegionEndLine,
		},
		finalRegion: {
			startLine: state.regionStartLine,
			endLine: state.regionEndLine,
		},
		baseFileState: state.baseFileState,
		finalFileState,
		edits: state.edits,
		relationship: classifyAcceptRelationship(state),
		stats: calculateFollowupStats(state.edits),
		metrics: {
			acceptedRegionCharEditDistance: computeCharEditDistance(baseRegionText, finalRegionText),
			fullFileCharEditDistance: computeCharEditDistance(state.baseFileState.text, finalFileState.text),
		},
	};
	logAcceptFollowupSample(followup);
}

function stopAcceptCaptureForAnotherAction(actionType: AcceptFollowupAnotherActionType): void {
	if (!acceptCaptureState) {
		return;
	}
	finalizeAcceptCapture('another_action', actionType);
}

function startAcceptCapture(
	sampleId: string,
	acceptedAt: number,
	action: Action
): void {
	stopAcceptCaptureForAnotherAction('new_suggestion');
	if (!isEditAction(action)) {
		return;
	}
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}
	const region = actionAcceptedLineRegion(action, editor.document.lineCount);
	if (!region) {
		return;
	}
	acceptCaptureState = {
		sampleId,
		acceptedAt,
		docUri: editor.document.uri.toString(),
		baseFileState: captureEditorFileState(editor),
		initialRegionStartLine: region.startLine,
		initialRegionEndLine: region.endLine,
		regionStartLine: region.startLine,
		regionEndLine: region.endLine,
		edits: [],
		firstEditAt: null,
		inactivityTimer: null,
		pendingSelectionSkipVersion: null,
		touchedRegionChangeCount: 0,
		outsideRegionChangeCount: 0,
	};
	resetAcceptCaptureTimer();
}

function captureAcceptFollowupEdit(e: vscode.TextDocumentChangeEvent): void {
	if (!acceptCaptureState || e.contentChanges.length === 0) {
		return;
	}
	if (acceptCaptureState.docUri !== e.document.uri.toString()) {
		stopAcceptCaptureForAnotherAction('file_switch');
		return;
	}

	for (const change of e.contentChanges) {
		const oldStartLine = change.range.start.line;
		const oldEndLine = change.range.end.line;
		const oldLineCount = change.rangeLength === 0
			? 0
			: Math.max(1, oldEndLine - oldStartLine + 1);
		const newLineCount = countLogicalLines(change.text);
		const lineDelta = newLineCount - oldLineCount;

		if (oldEndLine < acceptCaptureState.regionStartLine && lineDelta !== 0) {
			acceptCaptureState.regionStartLine = Math.max(0, acceptCaptureState.regionStartLine + lineDelta);
			acceptCaptureState.regionEndLine = Math.max(
				acceptCaptureState.regionStartLine,
				acceptCaptureState.regionEndLine + lineDelta
			);
		}

		const touchesRegion = rangesOverlap(
			oldStartLine,
			oldEndLine,
			acceptCaptureState.regionStartLine,
			acceptCaptureState.regionEndLine
		);
		if (touchesRegion) {
			acceptCaptureState.touchedRegionChangeCount += 1;
			const newEndLine = oldStartLine + Math.max(newLineCount - 1, 0);
			acceptCaptureState.regionStartLine = Math.max(0, Math.min(acceptCaptureState.regionStartLine, oldStartLine));
			acceptCaptureState.regionEndLine = Math.max(
				acceptCaptureState.regionStartLine,
				Math.max(acceptCaptureState.regionEndLine, newEndLine)
			);
		} else {
			stopAcceptCaptureForAnotherAction('cursor_far');
			return;
		}
	}

	const now = Date.now();
	if (acceptCaptureState.firstEditAt === null) {
		acceptCaptureState.firstEditAt = now;
	}
	const editEvent: RejectFollowupEditEvent = {
		ts: now,
		docVersion: e.document.version,
		contentChanges: e.contentChanges.map((change) => ({
			rangeOffset: change.rangeOffset,
			rangeLength: change.rangeLength,
			text: change.text,
		})),
	};
	acceptCaptureState.edits.push(editEvent);
	acceptCaptureState.pendingSelectionSkipVersion = e.document.version;
	resetAcceptCaptureTimer();
}

function handleAcceptCaptureSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
	if (!acceptCaptureState) {
		return;
	}
	if (acceptCaptureState.docUri !== e.textEditor.document.uri.toString()) {
		stopAcceptCaptureForAnotherAction('file_switch');
		return;
	}
	if (
		acceptCaptureState.pendingSelectionSkipVersion !== null
		&& acceptCaptureState.pendingSelectionSkipVersion === e.textEditor.document.version
	) {
		acceptCaptureState.pendingSelectionSkipVersion = null;
		return;
	}

	const cursorLine = e.textEditor.selection.active.line;
	if (cursorLine < acceptCaptureState.regionStartLine || cursorLine > acceptCaptureState.regionEndLine) {
		stopAcceptCaptureForAnotherAction('cursor_far');
	}
}

function handleAcceptCaptureEditorSwitch(editor: vscode.TextEditor | undefined): void {
	if (!acceptCaptureState) {
		return;
	}
	if (!editor || editor.document.uri.toString() !== acceptCaptureState.docUri) {
		stopAcceptCaptureForAnotherAction('file_switch');
	}
}


// Configuration helper
function getConfig() {
	const config = vscode.workspace.getConfiguration('crowd-pilot');
		return {
			hostname: config.get<string>('hostname', 'hai001'),
			port: config.get<number>('port', 30000),
			basePath: config.get<string>('basePath', '/v1/chat/completions'),
		modelName: config.get<string>('modelName', 'qwen/qwen3-8b'),
		minAvgLogprob: config.get<number>('minAvgLogprob', -1.0),
		enableModelLogging: config.get<boolean>('enableModelLogging', false),
		preferenceLogPath: config.get<string>('preferenceLogPath', ''),
		enablePreferenceLogging: config.get<boolean>('enablePreferenceLogging', true),
		sweepViewportLines: config.get<number>('sweepViewportLines', 21),
		sweepOpenedFileContext: config.get<string>('sweepOpenedFileContext', 'full'),
			sweepHistoryCenter: config.get<string>('sweepHistoryCenter', 'changed'),
			sweepMaxHistoryEntries: config.get<number>('sweepMaxHistoryEntries', 64),
			rejectFollowupPauseMs: config.get<number>('rejectFollowupPauseMs', 5000),
			acceptFollowupPauseMs: config.get<number>('acceptFollowupPauseMs', 5000),
			enablePreferenceUpload: config.get<boolean>('enablePreferenceUpload', true),
		};
	}


// Global conversation state manager instance
let conversationManager: SweepConversationStateManager;

// Track activated files (files whose content we've captured)
// TODO (f.srambical): This logic remains on the extension-side
// for backwards-compatibility (with the crowd-code dataset).
// Eventually, we should move the file tracking logic to
// p-doom/crowd-pilot-serializer.
const activatedFiles = new Set<string>();

/**
 * Clear all conversation context - resets the conversation manager and activated files.
 * Call this to start fresh without accumulated history.
 */
function clearContext(): void {
	conversationManager.reset();
	activatedFiles.clear();
	lastPredictionContext = null;
	clearRejectCaptureState();
	clearAcceptCaptureState();
	console.log('[crowd-pilot] Context cleared');
}

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

	const cfg = getConfig();
	conversationManager = new SweepConversationStateManager({
		viewportLines: cfg.sweepViewportLines,
		openedFileContext: cfg.sweepOpenedFileContext,
		historyCenter: cfg.sweepHistoryCenter,
		maxHistoryEntries: cfg.sweepMaxHistoryEntries,
	});
	initializePreferenceUploadIdentity(context);
	startPreferenceUploadInterval();
	void enqueuePreferenceLogTask(uploadAllLocalPreferenceLogs);

	previewManager = new PreviewManager();
	previewManager.register(context);

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
		if (!commandsToSkipShell.includes('crowd-pilot.showPendingAction')) {
			commandsToSkipShell.push('crowd-pilot.showPendingAction');
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
		stopAcceptCaptureForAnotherAction('new_suggestion');
		recordRejectAndArmCapture('escape_dismiss');
		hidePreviewUI(true);
	});

	const clearContextCmd = vscode.commands.registerCommand('crowd-pilot.clearContext', () => {
		clearContext();
		vscode.window.showInformationMessage('[crowd-pilot]: Context cleared');
	});

	const openPreferenceLogCmd = vscode.commands.registerCommand('crowd-pilot.openPreferenceLog', async () => {
		try {
			const logPath = await getLatestIndexedPreferenceLogPath();
			if (!logPath) {
				vscode.window.showInformationMessage('[crowd-pilot] No preference log file exists yet. Accept or reject some suggestions first.');
				return;
			}
			const uri = vscode.Uri.file(logPath);
			await vscode.window.showTextDocument(uri);
		} catch (err: any) {
			if (err.code === 'ENOENT' || err.message?.includes('ENOENT')) {
				vscode.window.showInformationMessage('[crowd-pilot] No preference log file exists yet. Accept or reject some suggestions first.');
			} else {
				vscode.window.showErrorMessage(`[crowd-pilot] Error opening preference log: ${err.message}`);
			}
		}
	});

	const modelRun = vscode.commands.registerCommand('crowd-pilot.modelRun', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		try {
			if (!previewManager.isVisible()) { return; }
			let action: Action | undefined = currentAction;
			if (!action) {
				const single = await requestModelActions(editor);
				currentAction = single;
				action = single;
			}
			if (!action) {
				hidePreviewUI();
				return;
			}
			stopAcceptCaptureForAnotherAction('new_suggestion');
			const recorded = recordPreferenceOutcome('accepted', 'tab_accept');
			clearRejectCaptureState();
			hidePreviewUI(false);
			await executeAction(action);
			if (recorded) {
				startAcceptCapture(recorded.sampleId, recorded.outcomeTimestamp, action);
			}
			autoShowNextAction();
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			vscode.window.showErrorMessage(`Model run failed: ${errorMessage}`);
		}
	});

	// Command to show pending action in quick pick (for terminal focus)
	const showPendingAction = vscode.commands.registerCommand('crowd-pilot.showPendingAction', async () => {
		if (!currentAction) {
			vscode.window.showInformationMessage('[crowd-pilot] No pending suggestion');
			return;
		}
		const result = await previewManager.showQuickPick();
		if (result === 'accept') {
			stopAcceptCaptureForAnotherAction('new_suggestion');
			const recorded = recordPreferenceOutcome('accepted', 'quickpick_accept');
			clearRejectCaptureState();
			hidePreviewUI(false);
			await executeAction(currentAction);
			if (recorded) {
				startAcceptCapture(recorded.sampleId, recorded.outcomeTimestamp, currentAction);
			}
			autoShowNextAction();
		} else if (result === 'dismiss') {
			stopAcceptCaptureForAnotherAction('new_suggestion');
			recordRejectAndArmCapture('quickpick_dismiss');
			hidePreviewUI(true);
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
			handleRejectCaptureSelectionChange(e);
			handleAcceptCaptureSelectionChange(e);
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
		handleRejectCaptureEditorSwitch(editor);
		handleAcceptCaptureEditorSwitch(editor);
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
			captureRejectFollowupEdit(e);
			captureAcceptFollowupEdit(e);
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
			stopRejectCaptureForAnotherAction('terminal_focus');
			stopAcceptCaptureForAnotherAction('terminal_focus');
			conversationManager.handleTerminalFocusEvent();
		}
	});

	// Terminal command execution event
	const onTerminalCommand = vscode.window.onDidStartTerminalShellExecution(async (event) => {
		stopRejectCaptureForAnotherAction('terminal_command');
		stopAcceptCaptureForAnotherAction('terminal_command');
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
		clearContextCmd,
		openPreferenceLogCmd,
		sglangTest,
		modelRun,
		showPendingAction,
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

export async function deactivate() {
	stopPreferenceUploadInterval();
	await enqueuePreferenceLogTask(uploadAllLocalPreferenceLogs);
	clearRejectCaptureState();
	clearAcceptCaptureState();
	previewManager?.dispose();
}

// -------------------- Execution --------------------
let currentAction: Action | undefined;

function getActiveOrCreateTerminal(): vscode.Terminal {
	if (vscode.window.activeTerminal) {
		return vscode.window.activeTerminal;
	}
	return vscode.window.createTerminal('crowd-pilot');
}

function clampPositionToDocument(
	doc: vscode.TextDocument,
	position: vscode.Position
): vscode.Position {
	if (doc.lineCount <= 0) {
		return new vscode.Position(0, 0);
	}
	const line = Math.min(Math.max(position.line, 0), doc.lineCount - 1);
	const maxChar = doc.lineAt(line).text.length;
	const character = Math.min(Math.max(position.character, 0), maxChar);
	return new vscode.Position(line, character);
}

function normalizeActionPosition(
	doc: vscode.TextDocument,
	position: [number, number]
): vscode.Position {
	if (doc.lineCount <= 0) {
		return new vscode.Position(0, 0);
	}
	const [line, character] = position;
	if (line >= doc.lineCount) {
		return doc.lineAt(doc.lineCount - 1).range.end;
	}
	return clampPositionToDocument(doc, new vscode.Position(line, character));
}

function setCursorPosition(editor: vscode.TextEditor, position: vscode.Position): void {
	const clamped = clampPositionToDocument(editor.document, position);
	const selection = new vscode.Selection(clamped, clamped);
	editor.selections = [selection];
	editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

async function executeAction(action: Action): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { return; }
	const doc = editor.document;
	if (action.kind === 'showTextDocument') {
		await vscode.window.showTextDocument(doc);
		return;
	}
	if (action.kind === 'setSelections') {
		editor.selections = action.selections.map(s => new vscode.Selection(
			new vscode.Position(s.start[0], s.start[1]),
			new vscode.Position(s.end[0], s.end[1])
		));
		editor.revealRange(editor.selections[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		return;
	}
	if (action.kind === 'editInsert') {
		const insertPosition = normalizeActionPosition(doc, action.position);
		const cursorText = dropSingleTrailingNewline(action.text);
		const [endLine, endCharacter] = advancePositionByText(
			[insertPosition.line, insertPosition.character],
			cursorText
		);
		const applied = await editor.edit((e: vscode.TextEditorEdit) => e.insert(insertPosition, action.text));
		if (!applied) {
			return;
		}
		setCursorPosition(editor, new vscode.Position(endLine, endCharacter));
		return;
	}
	if (action.kind === 'editDelete') {
		const startPosition = normalizeActionPosition(doc, action.range.start);
		const endPosition = normalizeActionPosition(doc, action.range.end);
		const range = new vscode.Range(
			startPosition,
			endPosition
		);
		const applied = await editor.edit((e: vscode.TextEditorEdit) => e.delete(range));
		if (!applied) {
			return;
		}
		setCursorPosition(editor, startPosition);
		return;
	}
	if (action.kind === 'editReplace') {
		const startPosition = normalizeActionPosition(doc, action.range.start);
		const endPosition = normalizeActionPosition(doc, action.range.end);
		const range = new vscode.Range(
			startPosition,
			endPosition
		);
		const cursorText = dropSingleTrailingNewline(action.text);
		const [endLine, endCharacter] = advancePositionByText(
			[startPosition.line, startPosition.character],
			cursorText
		);
		const applied = await editor.edit((e: vscode.TextEditorEdit) => e.replace(range, action.text));
		if (!applied) {
			return;
		}
		setCursorPosition(editor, new vscode.Position(endLine, endCharacter));
		return;
	}
	if (action.kind === 'terminalShow') {
		const term = getActiveOrCreateTerminal();
		term.show();
		return;
	}
	if (action.kind === 'terminalSendText') {
		const term = getActiveOrCreateTerminal();
		term.show();
		term.sendText(action.text, false);
		return;
	}
	if (action.kind === 'openFile') {
		const uri = vscode.Uri.file(action.filePath);
		const openedEditor = await vscode.window.showTextDocument(uri);
		if (action.selections) {
			openedEditor.selections = action.selections.map(s => new vscode.Selection(
				new vscode.Position(s.start[0], s.start[1]),
				new vscode.Position(s.end[0], s.end[1])
			));
			openedEditor.revealRange(openedEditor.selections[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
		return;
	}
}

// -------------------- UI State & Helpers --------------------
const UI_CONTEXT_KEY = 'crowdPilot.uiVisible';
const HAS_PENDING_ACTION_KEY = 'crowdPilot.hasPendingAction';
let previewManager: PreviewManager;
let suppressAutoPreview = false;
let latestRequestId = 0;
let currentAbortController: AbortController | undefined;

const PREDICTION_DEBOUNCE_MS = 150;
const PREDICTION_THROTTLE_MS = 300;

type PendingPrediction = { id: number; timer: NodeJS.Timeout };
type PredictionContext = {
	docUri: string;
	docVersion: number;
	actionLineRange: { start: number; end: number } | null;
};

let nextQueuedPredictionId = 0;
let pendingPredictions: PendingPrediction[] = [];
const cancelledPredictionIds = new Set<number>();
let lastPredictionTimestamp: number | undefined;
let lastPredictionContext: PredictionContext | null = null;

function getPredictionTimingMs(): { debounceMs: number; throttleMs: number } {
	const config = vscode.workspace.getConfiguration('crowd-pilot');
	const rawDebounce = config.get<number>('predictionDebounceMs', PREDICTION_DEBOUNCE_MS);
	const rawThrottle = config.get<number>('predictionThrottleMs', PREDICTION_THROTTLE_MS);
	const debounceMs = Number.isFinite(rawDebounce) ? Math.max(0, Math.floor(rawDebounce)) : PREDICTION_DEBOUNCE_MS;
	const throttleMs = Number.isFinite(rawThrottle) ? Math.max(0, Math.floor(rawThrottle)) : PREDICTION_THROTTLE_MS;
	return { debounceMs, throttleMs };
}

/**
 * Show preview UI for the given action using the PreviewManager.
 */
function showPreviewUI(action: Action): void {
	previewManager.show(action);
	const isVisible = previewManager.isVisible();
	if (!isVisible) {
		currentAction = undefined;
		vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
		vscode.commands.executeCommand('setContext', HAS_PENDING_ACTION_KEY, false);
		return;
	}
	currentAction = action;
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, true);
	vscode.commands.executeCommand('setContext', HAS_PENDING_ACTION_KEY, true);
}

/**
 * Hide the preview UI.
 */
function hidePreviewUI(suppress?: boolean): void {
	previewManager.clear();
	vscode.commands.executeCommand('setContext', UI_CONTEXT_KEY, false);
	vscode.commands.executeCommand('setContext', HAS_PENDING_ACTION_KEY, false);
	if (suppress) {
		suppressAutoPreview = true;
	}
}

function canRequestPrediction(editor: vscode.TextEditor, userRequested: boolean): boolean {
	if (!userRequested && suppressAutoPreview) {
		return false;
	}
	if (!userRequested) {
		if (!vscode.window.state.focused) {
			return false;
		}
		if (editor.document.getText().length === 0) {
			return false;
		}
		if (editor.selections.some(selection => !selection.isEmpty)) {
			return false;
		}
	}
	return true;
}

function actionLineRange(action: Action): { start: number; end: number } | null {
	if (action.kind === 'editReplace' || action.kind === 'editDelete') {
		return {
			start: action.range.start[0],
			end: action.range.end[0],
		};
	}
	if (action.kind === 'editInsert') {
		return {
			start: action.position[0],
			end: action.position[0],
		};
	}
	if (action.kind === 'setSelections') {
		const first = action.selections[0];
		if (!first) {
			return null;
		}
		return {
			start: first.start[0],
			end: first.end[0],
		};
	}
	if (action.kind === 'openFile' && action.selections && action.selections.length > 0) {
		const first = action.selections[0];
		return {
			start: first.start[0],
			end: first.end[0],
		};
	}
	return null;
}

function shouldReuseCurrentPrediction(editor: vscode.TextEditor): boolean {
	if (!currentAction || !previewManager.isVisible()) {
		return false;
	}
	if (!lastPredictionContext) {
		return false;
	}
	const doc = editor.document;
	if (doc.uri.toString() !== lastPredictionContext.docUri) {
		return false;
	}
	if (doc.version !== lastPredictionContext.docVersion) {
		return false;
	}
	if (editor.selections.some(selection => !selection.isEmpty)) {
		return false;
	}
	if (!lastPredictionContext.actionLineRange) {
		return false;
	}
	const cursorLine = editor.selection.active.line;
	return cursorLine >= lastPredictionContext.actionLineRange.start
		&& cursorLine <= lastPredictionContext.actionLineRange.end;
}

function shouldReplaceAction(current: Action, next: Action): boolean {
	if (current.kind !== next.kind) {
		return true;
	}
	if (current.kind === 'editReplace' && next.kind === 'editReplace') {
		const sameRange =
			current.range.start[0] === next.range.start[0] &&
			current.range.start[1] === next.range.start[1] &&
			current.range.end[0] === next.range.end[0] &&
			current.range.end[1] === next.range.end[1];
		if (!sameRange) {
			return true;
		}
		return !next.text.startsWith(current.text);
	}
	if (current.kind === 'setSelections' && next.kind === 'setSelections') {
		const c = current.selections[0];
		const n = next.selections[0];
		if (!c || !n) {
			return true;
		}
		return !(
			c.start[0] === n.start[0]
			&& c.start[1] === n.start[1]
			&& c.end[0] === n.end[0]
			&& c.end[1] === n.end[1]
		);
	}
	return true;
}

/**
 * Schedule a model preview refresh, coalescing rapid editor events and
 * throttling how often we actually talk to the model.
 */
function schedulePredictionRefresh(debounce: boolean, userRequested: boolean): void {
	if (!suggestionsEnabled) {
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		hidePreviewUI();
		return;
	}
	if (!canRequestPrediction(editor, userRequested)) {
		hidePreviewUI();
		return;
	}

	const now = Date.now();
	const id = ++nextQueuedPredictionId;
	const timing = getPredictionTimingMs();

	let delay = 0;
	if (debounce) {
		delay = Math.max(delay, timing.debounceMs);
	}
	if (lastPredictionTimestamp !== null && lastPredictionTimestamp !== undefined) {
		const elapsed = now - lastPredictionTimestamp;
		if (elapsed < timing.throttleMs) {
			delay = Math.max(delay, timing.throttleMs - elapsed);
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
	if (!canRequestPrediction(editor, false)) {
		hidePreviewUI();
		return;
	}
	if (shouldReuseCurrentPrediction(editor)) {
		return;
	}
	try {
		currentAbortController?.abort();
		const controller = new AbortController();
		currentAbortController = controller;
		const requestId = ++latestRequestId;
		const next = await requestModelActions(editor, controller.signal);
		if (requestId !== latestRequestId) { return; }
		if (next) {
			if (currentAction && previewManager.isVisible() && !shouldReplaceAction(currentAction, next)) {
				return;
			}
			showPreviewUI(next);
		} else {
			hidePreviewUI();
		}
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
	const requestId = createModelLogId();
	try {
		await logModelPrompt(requestId, JSON.stringify(requestBody, null, 2));
	} catch (err) {
		console.error('[crowd-pilot] Failed to log model prompt:', err);
	}
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
					void (async () => {
						try {
							await logModelResponse(requestId, data);
						} catch (err) {
							console.error('[crowd-pilot] Failed to log model response:', err);
						}
						try {
							resolve(JSON.parse(data));
						} catch (err) {
							reject(new Error(`Failed to parse response: ${err instanceof Error ? err.message : String(err)}`));
						}
					})();
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
async function requestModelActions(editor: vscode.TextEditor, signal?: AbortSignal): Promise<Action> {
	const cfg = getConfig();
	const headers: any = {
		'Content-Type': 'application/json'
	};

	const doc = editor.document;
	const promptPayload = conversationManager.finalizeForModel();
	const conversationMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
		promptPayload.messages.map((msg: any) => {
			const role = msg.role === 'assistant' ? 'assistant' : msg.role === 'user' ? 'user' : 'system';
			return { role, content: msg.content };
		});
	if (conversationMessages.length === 0) {
		throw new Error('Sweep prompt is empty');
	}
	const requestContext: SweepRequestContext = {
		docUri: doc.uri.toString(),
		docVersion: doc.version,
		targetFile: String(promptPayload.targetFile ?? doc.uri.fsPath),
		windowStartLine: Number(promptPayload.windowStartLine ?? 1),
		windowEndLine: Number(promptPayload.windowEndLine ?? 0),
		currentWindow: String(promptPayload.currentWindow ?? ''),
	};

	const prompt: PreferencePrompt = {
		model: cfg.modelName,
		messages: conversationMessages,
		temperature: 0.7,
		top_p: 0.8,
		top_k: 20,
		min_p: 0,
		logprobs: true,
		chat_template_kwargs: {
			enable_thinking: false
		},
	};

	const requestBody: any = {
		model: prompt.model,
		messages: prompt.messages,
		temperature: prompt.temperature,
		top_p: prompt.top_p,
		top_k: prompt.top_k,
		min_p: prompt.min_p,
		logprobs: prompt.logprobs,
		chat_template_kwargs: prompt.chat_template_kwargs,
	};
	const requestId = createModelLogId();
	try {
		await logModelPrompt(requestId, JSON.stringify(requestBody, null, 2));
	} catch (err) {
		console.error('[crowd-pilot] Failed to log model prompt:', err);
	}

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
				void (async () => {
					try {
						await logModelResponse(requestId, data);
					} catch (err) {
						console.error('[crowd-pilot] Failed to log model response:', err);
					}
					try {
						resolve(JSON.parse(data));
					} catch (err) {
						reject(new Error(`Failed to parse response: ${err instanceof Error ? err.message : String(err)}`));
					}
				})();
			});
		});
		req.on('error', (err: Error) => reject(err));
		req.write(postData);
		req.end();
	});

	const avgLogprob = calculateAverageLogprob(json);
	if (avgLogprob < cfg.minAvgLogprob) {
		return undefined as any; // Low confidence, silently skip suggestion
	}

	const content = extractChatContent(json);
	if (typeof content !== 'string' || content.trim().length === 0) {
		throw new Error('Empty model content');
	}
	const currentDoc = editor.document;
	if (currentDoc.uri.toString() !== requestContext.docUri) {
		return undefined as any;
	}
	if (currentDoc.version !== requestContext.docVersion
		&& !isSweepResponseStillApplicable(currentDoc, requestContext)) {
		return undefined as any;
	}

	const action = parseSweepAction(content, currentDoc);
	
	if (!action) {
		throw new Error('No valid action parsed from model output');
	}
	lastPredictionContext = {
		docUri: currentDoc.uri.toString(),
		docVersion: currentDoc.version,
		actionLineRange: actionLineRange(action),
	};
	const fileState = captureEditorFileState(editor);

	markPendingAsIgnored();

	createPendingPreferenceSample(
		prompt,
		conversationMessages,
		fileState,
		content,
		action,
		avgLogprob,
		cfg.modelName
	);

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
	const logprobs = json?.choices?.[0]?.logprobs;
	const tokens = logprobs?.content;
	if (!Array.isArray(tokens) || tokens.length === 0) {
		return Number.NEGATIVE_INFINITY;
	}
	let sum = 0;
	let count = 0;
	for (const token of tokens) {
		if (typeof token.logprob === 'number') {
			sum += token.logprob;
			count += 1;
		}
	}
	if (count === 0) {
		return Number.NEGATIVE_INFINITY;
	}
	return sum / count;
}

type SweepRequestContext = {
	docUri: string;
	docVersion: number;
	targetFile: string;
	windowStartLine: number;
	windowEndLine: number;
	currentWindow: string;
};

function normalizeWindowText(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

function getDocumentWindowText(
	doc: vscode.TextDocument,
	windowStartLine: number,
	windowEndLine: number
): string {
	if (doc.lineCount <= 0) {
		return '';
	}
	if (windowEndLine < windowStartLine) {
		return '';
	}
	const start0 = Math.max(0, windowStartLine - 1);
	const end0 = Math.max(start0, windowEndLine - 1);
	if (start0 >= doc.lineCount) {
		return '';
	}
	const clampedEnd = Math.min(end0, doc.lineCount - 1);
	const lines: string[] = [];
	for (let line = start0; line <= clampedEnd; line += 1) {
		lines.push(doc.lineAt(line).text);
	}
	return lines.join('\n');
}

function isSweepResponseStillApplicable(
	doc: vscode.TextDocument,
	requestContext: SweepRequestContext
): boolean {
	if (path.normalize(doc.uri.fsPath) !== path.normalize(requestContext.targetFile)) {
		return false;
	}
	const currentWindow = getDocumentWindowText(
		doc,
		requestContext.windowStartLine,
		requestContext.windowEndLine
	);
	return normalizeWindowText(currentWindow) === normalizeWindowText(requestContext.currentWindow);
}

function parseSweepAction(raw: string, doc: vscode.TextDocument): Action | undefined {
	const normalized = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
	if (!normalized) {
		return undefined;
	}

	let parsed: SweepParsedEdit | null = null;
	try {
		parsed = conversationManager.parseModelResponse(normalized) as SweepParsedEdit | null;
	} catch {
		return undefined;
	}
	if (!parsed) {
		return undefined;
	}
	const snapshot = {
		activeFilePath: doc.uri.fsPath,
		lineCount: doc.lineCount,
		lastLineLength: doc.lineCount > 0 ? doc.lineAt(doc.lineCount - 1).range.end.character : 0,
	};
	return parsedSweepEditToAction(parsed, snapshot) as Action | undefined;
}
