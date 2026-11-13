import * as vscode from 'vscode';
import { PiSession } from '../sessions/types';

/**
 * Returns the path to the Pi CLI: the `patisserie.piPath` setting if set,
 * else `pi` found on `PATH`. Returns `undefined` if not found (FR-16, FR-17).
 */
export async function resolvePiPath(): Promise<string | undefined> {
	throw new Error('Not implemented');
}

/** Opens a terminal in `workspaceRoot` that resumes `session` (FR-12 to FR-15, FR-18). */
export async function openSessionInTerminal(session: PiSession, workspaceRoot: vscode.Uri): Promise<void> {
	throw new Error('Not implemented');
}
