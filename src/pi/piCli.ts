import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PiSession } from '../sessions/types';

async function isExecutableFile(file: string): Promise<boolean> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile()) {
			return false;
		}
		await fs.access(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Searches `pathEnv` for an executable `pi`. On Windows, also tries the
 * extensions in `pathExt`. Pure apart from file system checks; no shell is spawned.
 */
export async function findPiOnPath(
	pathEnv: string | undefined,
	pathExt: string | undefined,
	platform: NodeJS.Platform,
	delimiter: string = path.delimiter,
): Promise<string | undefined> {
	if (!pathEnv) {
		return undefined;
	}
	const exts = platform === 'win32'
		? ['', ...(pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(e => e.length > 0)]
		: [''];
	for (const dir of pathEnv.split(delimiter)) {
		if (dir.length === 0) {
			continue;
		}
		for (const ext of exts) {
			const candidate = path.join(dir, `pi${ext}`);
			if (await isExecutableFile(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

/**
 * Returns the path to the Pi CLI: the `patisserie.piPath` setting if set,
 * else `pi` found on `PATH`. Returns `undefined` if not found (FR-16, FR-17).
 */
export async function resolvePiPath(): Promise<string | undefined> {
	const configured = vscode.workspace.getConfiguration('patisserie').get<string>('piPath', '').trim();
	if (configured.length > 0) {
		const expanded = configured === '~' || configured.startsWith('~/') || configured.startsWith('~\\')
			? path.join(os.homedir(), configured.slice(1))
			: configured;
		return (await isExecutableFile(expanded)) ? expanded : undefined;
	}
	return findPiOnPath(process.env.PATH, process.env.PATHEXT, process.platform);
}

/** Opens a terminal in `workspaceRoot` that resumes `session` (FR-12 to FR-15, FR-18). */
export async function openSessionInTerminal(session: PiSession, workspaceRoot: vscode.Uri): Promise<void> {
	const piPath = await resolvePiPath();
	if (piPath === undefined) {
		const openSettings = 'Open Settings';
		const choice = await vscode.window.showErrorMessage(
			'Pi CLI was not found. Install it or set the path in the settings.',
			openSettings,
		);
		if (choice === openSettings) {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'patisserie.piPath');
		}
		return;
	}
	const terminal = vscode.window.createTerminal({
		name: `Pi: ${session.name ?? session.id}`,
		cwd: workspaceRoot,
		shellPath: piPath,
		shellArgs: ['--session', session.id],
	});
	terminal.show();
}
