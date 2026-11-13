import { spawn } from 'node:child_process';
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

/** Shows the "Pi CLI not found" error with a link to the setting (FR-18). */
async function showPiNotFound(): Promise<void> {
	const openSettings = 'Open Settings';
	const choice = await vscode.window.showErrorMessage(
		'Pi CLI was not found. Install it or set the path in the settings.',
		openSettings,
	);
	if (choice === openSettings) {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'patisserie.piPath');
	}
}

/** Starts Pi directly, keeping user input out of shell command parsing. */
async function launchTerminal(workspaceRoot: vscode.Uri, name: string, args: string[]): Promise<vscode.Terminal | undefined> {
	const piPath = await resolvePiPath();
	if (piPath === undefined) {
		await showPiNotFound();
		return undefined;
	}
	const terminal = vscode.window.createTerminal({
		name,
		cwd: workspaceRoot,
		shellPath: piPath,
		shellArgs: args,
	});
	terminal.show();
	return terminal;
}

/** Opens a terminal that resumes the selected session. */
export function openSessionInTerminal(session: PiSession, workspaceRoot: vscode.Uri): Promise<vscode.Terminal | undefined> {
	return launchTerminal(workspaceRoot, `Pi: ${session.name ?? session.id}`, ['--session', session.id]);
}

export function continueLatestSession(workspaceRoot: vscode.Uri): Promise<vscode.Terminal | undefined> {
	return launchTerminal(workspaceRoot, 'Pi: Continue Latest Session', ['--continue']);
}

export async function newNamedSession(workspaceRoot: vscode.Uri): Promise<vscode.Terminal | undefined> {
	const name = await vscode.window.showInputBox({
		title: 'New Pi Session',
		prompt: 'Enter a name for the new session',
		validateInput: value => value.trim() ? undefined : 'Enter a name.',
	});
	if (!name?.trim()) {
		return undefined;
	}
	return launchTerminal(workspaceRoot, `Pi: ${name.trim()}`, ['--name', name.trim()]);
}

export function forkSession(session: PiSession, workspaceRoot: vscode.Uri): Promise<vscode.Terminal | undefined> {
	return launchTerminal(workspaceRoot, `Pi: Fork ${session.name ?? session.id}`, ['--fork', session.id]);
}

const RPC_TIMEOUT_MS = 15_000;

/**
 * Sends one command to `pi --mode rpc` for `sessionFile` and resolves with the
 * matching response. Pi writes the session file; the extension does not (FR-19).
 */
export function sendRpcCommand(
	piPath: string,
	sessionFile: string,
	cwd: string,
	command: Record<string, unknown>,
	timeoutMs = RPC_TIMEOUT_MS,
): Promise<{ success: boolean; error?: string }> {
	return new Promise((resolve, reject) => {
		const id = `patisserie-${Date.now()}`;
		const child = spawn(piPath, ['--mode', 'rpc', '--session', sessionFile], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		let buffer = '';
		let stderr = '';
		let settled = false;

		const finish = (err: Error | undefined, result?: { success: boolean; error?: string }) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			// Closing stdin asks Pi to shut down cleanly.
			child.stdin.end();
			if (err) {
				reject(err);
			} else {
				resolve(result!);
			}
		};

		const timer = setTimeout(() => {
			child.kill();
			finish(new Error('Pi did not respond in time.'));
		}, timeoutMs);

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			// RPC records are split on LF only (not U+2028/U+2029), per Pi's framing rules.
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, '');
				buffer = buffer.slice(newline + 1);
				let record: unknown;
				try {
					record = JSON.parse(line);
				} catch {
					continue;
				}
				const r = record as { type?: unknown; id?: unknown; success?: unknown; error?: unknown };
				if (r.type === 'response' && r.id === id) {
					finish(undefined, { success: r.success === true, error: typeof r.error === 'string' ? r.error : undefined });
				}
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.on('error', err => finish(err));
		child.on('exit', code => {
			finish(new Error(`Pi exited (code ${code ?? 'unknown'}) before it answered.${stderr ? ` ${stderr.trim().slice(0, 300)}` : ''}`));
		});

		child.stdin.on('error', () => { /* reported through 'exit' or the timeout */ });
		child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
	});
}

/** Asks the user for a new name and lets Pi store it with `set_session_name`. Returns true if renamed. */
export async function renameSession(session: PiSession, workspaceRoot: vscode.Uri): Promise<boolean> {
	const name = await vscode.window.showInputBox({
		title: 'Rename Pi Session',
		prompt: `Session ${session.id}`,
		value: session.name ?? '',
		valueSelection: [0, (session.name ?? '').length],
		validateInput: value => (value.trim() ? undefined : 'Enter a name.'),
	});
	if (name === undefined || name.trim() === (session.name ?? '')) {
		return false;
	}
	const piPath = await resolvePiPath();
	if (piPath === undefined) {
		await showPiNotFound();
		return false;
	}
	try {
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: 'Renaming Pi session…' },
			() => sendRpcCommand(piPath, session.filePath, workspaceRoot.fsPath, { type: 'set_session_name', name: name.trim() }),
		);
		if (!result.success) {
			throw new Error(result.error ?? 'Pi refused the new name.');
		}
		return true;
	} catch (err) {
		void vscode.window.showErrorMessage(`Could not rename the session: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}
