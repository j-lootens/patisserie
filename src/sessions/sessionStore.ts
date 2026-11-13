import { readFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PiSession, SessionStatus } from './types';

/**
 * Encodes a working directory the way Pi names its session folders,
 * for example `/Users/me/repo` becomes `--Users-me-repo--`.
 */
export function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function expandTilde(p: string): string {
	if (p === '~') {
		return os.homedir();
	}
	if (p.startsWith('~/') || p.startsWith('~\\')) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

/** Pi's agent directory: `PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export function getAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	return env ? expandTilde(env) : path.join(os.homedir(), '.pi', 'agent');
}

async function readSettingsSessionDir(): Promise<string | undefined> {
	try {
		const raw = await readFile(path.join(getAgentDir(), 'settings.json'), 'utf8');
		const value: unknown = (JSON.parse(raw) as { sessionDir?: unknown } | null)?.sessionDir;
		return typeof value === 'string' && value ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolves the directory to read. Like Pi, a custom directory (env var or
 * settings) is used as-is, without a `--cwd--` subfolder.
 */
async function resolveDir(workspaceRoot: string): Promise<{ dir: string; custom: boolean }> {
	const env = process.env.PI_CODING_AGENT_SESSION_DIR;
	if (env) {
		return { dir: expandTilde(env), custom: true };
	}
	const setting = await readSettingsSessionDir();
	if (setting) {
		return { dir: expandTilde(setting), custom: true };
	}
	return { dir: path.join(getAgentDir(), 'sessions', encodeCwd(workspaceRoot)), custom: false };
}

/**
 * Returns the folder that holds the sessions for `workspaceRoot`.
 * Honors `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` Pi setting.
 * A custom directory is returned as-is; it can hold sessions of many
 * workspaces, which `listSessions` filters by header `cwd`.
 */
export async function getSessionDir(workspaceRoot: string): Promise<string> {
	return (await resolveDir(workspaceRoot)).dir;
}

/**
 * Entries that change session settings, not the conversation. They don't count
 * as activity, so renaming a session doesn't move it to the top of the list.
 */
const METADATA_ENTRIES = new Set(['session_info', 'label', 'thinking_level_change', 'model_change']);

function toDate(value: unknown): Date | undefined {
	if (typeof value !== 'string' && typeof value !== 'number') {
		return undefined;
	}
	const d = new Date(value);
	return isNaN(d.getTime()) ? undefined : d;
}

function costOf(obj: unknown): number | undefined {
	const total = (obj as { cost?: { total?: unknown } } | null | undefined)?.cost?.total;
	return typeof total === 'number' && Number.isFinite(total) ? total : undefined;
}

interface Parsed {
	session: PiSession;
	cwd?: string;
	/** Cost per entry ID, to find what a fork copied from its parent. */
	entryCosts: Map<string, number>;
}

async function parseWithCwd(filePath: string): Promise<Parsed | undefined> {
	let text: string;
	try {
		text = await readFile(filePath, 'utf8');
	} catch {
		return undefined;
	}
	const lines = text.split(/\r?\n/);
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(lines[0]) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (!header || header.type !== 'session' || typeof header.id !== 'string' || !header.id) {
		return undefined;
	}
	const startTime = toDate(header.timestamp);
	if (!startTime) {
		return undefined;
	}
	let lastActivity = startTime;
	let name: string | undefined;
	let cost: number | undefined;
	let agentTurn = false;
	const entryCosts = new Map<string, number>();
	for (let i = 1; i < lines.length; i++) {
		if (!lines[i].trim()) {
			continue;
		}
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(lines[i]) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const ts = toDate(entry.timestamp);
		if (ts && ts > lastActivity && !METADATA_ENTRIES.has(entry.type as string)) {
			lastActivity = ts;
		}
		if (entry.type === 'message') {
			const msg = entry.message as { role?: unknown; stopReason?: unknown } | undefined;
			agentTurn = msg?.role === 'user' || msg?.role === 'toolResult'
				|| (msg?.role === 'assistant' && msg.stopReason === 'toolUse');
		}
		if (entry.type === 'session_info' && typeof entry.name === 'string') {
			name = entry.name;
		}
		for (const c of [costOf((entry.message as { usage?: unknown } | undefined)?.usage), costOf(entry.usage)]) {
			if (c !== undefined) {
				cost = (cost ?? 0) + c;
				if (typeof entry.id === 'string') {
					entryCosts.set(entry.id, (entryCosts.get(entry.id) ?? 0) + c);
				}
			}
		}
	}
	return {
		session: {
			id: header.id, name, filePath, startTime, lastActivity, cost, agentTurn,
			parentSession: typeof header.parentSession === 'string' && header.parentSession ? header.parentSession : undefined,
		},
		cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
		entryCosts,
	};
}

/** Parses one session file. Returns `undefined` if the file is not a valid session. */
export async function parseSessionFile(filePath: string): Promise<PiSession | undefined> {
	return (await parseWithCwd(filePath))?.session;
}

function samePath(a: string, b: string): boolean {
	const n = (p: string) => path.resolve(p).replace(/[/\\]+$/, '');
	return process.platform === 'win32' || process.platform === 'darwin'
		? n(a).toLowerCase() === n(b).toLowerCase()
		: n(a) === n(b);
}

/**
 * A fork starts with a copy of its parent's entries, with the same IDs and
 * costs. Removes those from the fork's cost so they count once (FR-35).
 */
async function subtractInherited(p: Parsed, byFile: Map<string, Parsed>): Promise<Parsed> {
	const parentFile = p.session.parentSession;
	if (!parentFile) {
		return p;
	}
	const parent = byFile.get(path.resolve(parentFile)) ?? await parseWithCwd(parentFile);
	if (!parent) {
		return p;
	}
	let inherited = 0;
	let own: number | undefined;
	for (const [id, c] of p.entryCosts) {
		if (parent.entryCosts.has(id)) {
			inherited += c;
		} else {
			own = (own ?? 0) + c;
		}
	}
	return { ...p, session: { ...p.session, cost: own, inheritedCost: inherited || undefined } };
}

/** Lists the sessions for `workspaceRoot`, newest last activity first (FR-4). Read-only (FR-19). */
export async function listSessions(workspaceRoot: string): Promise<PiSession[]> {
	const { dir, custom } = await resolveDir(workspaceRoot);
	let files: string[];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
	} catch {
		return [];
	}
	const parsed = (await Promise.all(files.map((f) => parseWithCwd(path.join(dir, f)))))
		.filter((p): p is Parsed => p !== undefined);
	const byFile = new Map(parsed.map((p) => [path.resolve(p.session.filePath), p]));
	const withOwnCost = await Promise.all(parsed.map((p) => subtractInherited(p, byFile)));
	return withOwnCost
		.filter((p) => !custom || (p.cwd !== undefined && samePath(p.cwd, workspaceRoot)))
		.map((p) => p.session)
		.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
}

/** A session whose agent turn has seen no write for this long is treated as stopped. */
export const WORKING_STALE_MS = 5 * 60_000;
/** A finished session without an open terminal counts as waiting for this long. */
export const WAITING_RECENT_MS = 15 * 60_000;

/**
 * Works out the live state of a session (FR-30, FR-31). Pi doesn't keep the
 * session file open, so this uses the last message, its age, and whether the
 * extension has an open terminal for the session.
 */
export function sessionStatus(session: PiSession, now: number, hasOpenTerminal = false): SessionStatus {
	const age = now - session.lastActivity.getTime();
	if (session.agentTurn) {
		return age < WORKING_STALE_MS ? 'working' : (hasOpenTerminal ? 'waiting' : 'inactive');
	}
	return hasOpenTerminal || age < WAITING_RECENT_MS ? 'waiting' : 'inactive';
}

/** Sessions grouped by fork parent. Keys are parent session IDs; `undefined` holds the roots. */
export type SessionForest = Map<string | undefined, PiSession[]>;

/**
 * Nests forks under the session they came from (FR-33). A fork whose parent is
 * not in the list (deleted, or in another workspace) becomes a root. Keeps the
 * order of `sessions` inside each group.
 */
export function buildSessionForest(sessions: readonly PiSession[]): SessionForest {
	const byFile = new Map(sessions.map(s => [path.resolve(s.filePath), s]));
	const forest: SessionForest = new Map();
	for (const session of sessions) {
		const parent = session.parentSession ? byFile.get(path.resolve(session.parentSession)) : undefined;
		const key = parent && parent !== session ? parent.id : undefined;
		const group = forest.get(key);
		if (group) {
			group.push(session);
		} else {
			forest.set(key, [session]);
		}
	}
	return forest;
}
