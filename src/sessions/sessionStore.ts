import { readFile, readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PiSession } from './types';

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

function getAgentDir(): string {
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

async function parseWithCwd(filePath: string): Promise<{ session: PiSession; cwd?: string } | undefined> {
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
		if (ts && ts > lastActivity) {
			lastActivity = ts;
		}
		if (entry.type === 'session_info' && typeof entry.name === 'string') {
			name = entry.name;
		}
		for (const c of [costOf((entry.message as { usage?: unknown } | undefined)?.usage), costOf(entry.usage)]) {
			if (c !== undefined) {
				cost = (cost ?? 0) + c;
			}
		}
	}
	return {
		session: { id: header.id, name, filePath, startTime, lastActivity, cost },
		cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
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

/** Lists the sessions for `workspaceRoot`, newest last activity first (FR-4). Read-only (FR-19). */
export async function listSessions(workspaceRoot: string): Promise<PiSession[]> {
	const { dir, custom } = await resolveDir(workspaceRoot);
	let files: string[];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
	} catch {
		return [];
	}
	const parsed = await Promise.all(files.map((f) => parseWithCwd(path.join(dir, f))));
	return parsed
		.filter((p): p is { session: PiSession; cwd?: string } => p !== undefined)
		.filter((p) => !custom || (p.cwd !== undefined && samePath(p.cwd, workspaceRoot)))
		.map((p) => p.session)
		.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
}
