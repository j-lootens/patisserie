import { PiSession } from './types';

/**
 * Encodes a working directory the way Pi names its session folders,
 * for example `/Users/me/repo` becomes `--Users-me-repo--`.
 */
export function encodeCwd(cwd: string): string {
	throw new Error('Not implemented');
}

/**
 * Returns the folder that holds the sessions for `workspaceRoot`.
 * Honors `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` Pi setting.
 */
export async function getSessionDir(workspaceRoot: string): Promise<string> {
	throw new Error('Not implemented');
}

/** Parses one session file. Returns `undefined` if the file is not a valid session. */
export async function parseSessionFile(filePath: string): Promise<PiSession | undefined> {
	throw new Error('Not implemented');
}

/** Lists the sessions for `workspaceRoot`, newest last activity first (FR-4). Read-only (FR-19). */
export async function listSessions(workspaceRoot: string): Promise<PiSession[]> {
	throw new Error('Not implemented');
}
