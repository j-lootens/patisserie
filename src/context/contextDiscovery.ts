import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { getAgentDir } from '../sessions/sessionStore';

/**
 * Pi files that shape a session but are not recorded in the session file.
 * Found on disk now, so they may differ from what the session used.
 */
export interface DiskResources {
	/** `AGENTS.md`-style files in the agent dir, `cwd` and its parents (fallback for sessions that don't record them). */
	readonly contextFiles: readonly string[];
	/** `SYSTEM.md` and `APPEND_SYSTEM.md`. */
	readonly systemPromptFiles: readonly string[];
	readonly promptTemplates: readonly string[];
	readonly extensions: readonly string[];
	readonly mcpConfigs: readonly string[];
}

/** Context file names in Pi's order of preference within one directory. */
const CONTEXT_FILE_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

async function isFile(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isFile();
	} catch {
		return false;
	}
}

async function existingFiles(candidates: readonly string[]): Promise<string[]> {
	const found = await Promise.all(candidates.map(async p => ((await isFile(p)) ? p : undefined)));
	return found.filter((p): p is string => p !== undefined);
}

async function contextFileIn(dir: string): Promise<string | undefined> {
	// `readdir` gives the real name casing, so `AGENTS.md` and `AGENTS.MD`
	// are told apart on case-insensitive file systems.
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return undefined;
	}
	const name = CONTEXT_FILE_NAMES.find(n => names.includes(n));
	return name && (await isFile(path.join(dir, name))) ? path.join(dir, name) : undefined;
}

async function listDir(dir: string, filter: (name: string) => boolean): Promise<string[]> {
	try {
		const names = await readdir(dir);
		return names.filter(n => !n.startsWith('.') && filter(n)).sort().map(n => path.join(dir, n));
	} catch {
		return [];
	}
}

/** Finds the Pi resources for a session that runs in `cwd`. Read-only. */
export async function discoverResources(cwd: string): Promise<DiskResources> {
	const agentDir = getAgentDir();
	const projectDir = path.join(cwd, '.pi');

	const ancestors: string[] = [];
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		ancestors.push(dir);
		if (path.dirname(dir) === dir) {
			break;
		}
	}
	// Agent dir first, then from the file system root down to `cwd`.
	const contextDirs = [agentDir, ...ancestors.reverse()];
	const contextFiles = (await Promise.all(contextDirs.map(contextFileIn)))
		.filter((p): p is string => p !== undefined);

	const [systemPromptFiles, promptTemplates, extensions, mcpConfigs] = await Promise.all([
		existingFiles([
			path.join(agentDir, 'SYSTEM.md'),
			path.join(agentDir, 'APPEND_SYSTEM.md'),
			path.join(projectDir, 'SYSTEM.md'),
			path.join(projectDir, 'APPEND_SYSTEM.md'),
		]),
		Promise.all([agentDir, projectDir].map(d => listDir(path.join(d, 'prompts'), n => n.endsWith('.md')))).then(l => l.flat()),
		Promise.all([agentDir, projectDir].map(d => listDir(path.join(d, 'extensions'), () => true))).then(l => l.flat()),
		existingFiles([path.join(agentDir, 'mcp.json'), path.join(projectDir, 'mcp.json')]),
	]);

	return { contextFiles: [...new Set(contextFiles)], systemPromptFiles, promptTemplates, extensions, mcpConfigs };
}
