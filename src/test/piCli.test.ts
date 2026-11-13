import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { continueLatestSession, findPiOnPath, forkSession, openSessionInTerminal, resolvePiPath, sendRpcCommand } from '../pi/piCli';

suite('piCli', () => {
	let dir: string;
	let fakePi: string;
	let originalSetting: string | undefined;

	const config = () => vscode.workspace.getConfiguration('patisserie');

	setup(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cli-test-'));
		fakePi = path.join(dir, 'pi');
		await fs.writeFile(fakePi, '#!/bin/sh\nexit 0\n');
		await fs.chmod(fakePi, 0o755);
		originalSetting = config().inspect<string>('piPath')?.globalValue;
	});

	teardown(async () => {
		await config().update('piPath', originalSetting, vscode.ConfigurationTarget.Global);
		await fs.rm(dir, { recursive: true, force: true });
	});

	test('findPiOnPath finds executable pi', async () => {
		const other = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cli-empty-'));
		try {
			const found = await findPiOnPath([other, dir].join(path.delimiter), undefined, 'linux');
			assert.strictEqual(found, fakePi);
		} finally {
			await fs.rm(other, { recursive: true, force: true });
		}
	});

	test('findPiOnPath ignores non-executable files and missing PATH', async () => {
		await fs.chmod(fakePi, 0o644);
		assert.strictEqual(await findPiOnPath(dir, undefined, 'linux'), undefined);
		assert.strictEqual(await findPiOnPath(undefined, undefined, 'linux'), undefined);
		assert.strictEqual(await findPiOnPath('', undefined, 'linux'), undefined);
	});

	test('findPiOnPath tries PATHEXT on win32 with ; delimiter', async () => {
		await fs.rm(fakePi);
		const cmd = path.join(dir, 'pi.CMD');
		await fs.writeFile(cmd, 'x');
		await fs.chmod(cmd, 0o755);
		assert.strictEqual(await findPiOnPath(dir, '.EXE;.CMD', 'win32', ';'), cmd);
		assert.strictEqual(await findPiOnPath(dir, '.EXE;.CMD', 'linux'), undefined);
	});

	test('resolvePiPath honors explicit setting', async () => {
		await config().update('piPath', fakePi, vscode.ConfigurationTarget.Global);
		assert.strictEqual(await resolvePiPath(), fakePi);
	});

	test('resolvePiPath returns undefined for invalid setting', async () => {
		await config().update('piPath', path.join(dir, 'nope'), vscode.ConfigurationTarget.Global);
		assert.strictEqual(await resolvePiPath(), undefined);
		await config().update('piPath', dir, vscode.ConfigurationTarget.Global);
		assert.strictEqual(await resolvePiPath(), undefined);
	});

	test('openSessionInTerminal creates a named terminal', async () => {
		await config().update('piPath', fakePi, vscode.ConfigurationTarget.Global);
		const before = new Set(vscode.window.terminals);
		await openSessionInTerminal(
			{
				id: 'abc-123',
				name: 'My session',
				filePath: '/tmp/x.jsonl',
				startTime: new Date(),
				lastActivity: new Date(),
			},
			vscode.Uri.file(dir),
		);
		const created = vscode.window.terminals.filter(t => !before.has(t));
		try {
			assert.ok(created.some(t => t.name === 'Pi: My session'));
		} finally {
			created.forEach(t => t.dispose());
		}
	});

	test('continue and fork launch Pi with separate arguments in the workspace', async () => {
		await config().update('piPath', fakePi, vscode.ConfigurationTarget.Global);
		const before = new Set(vscode.window.terminals);
		const root = vscode.Uri.file(dir);
		try {
			await continueLatestSession(root);
			await forkSession({
				id: 'fork-source', name: 'Source', filePath: '/tmp/source.jsonl',
				startTime: new Date(), lastActivity: new Date(),
			}, root);
			const created = vscode.window.terminals.filter(t => !before.has(t));
			assert.strictEqual(created.length, 2);
			for (const [index, args] of [['--continue'], ['--fork', 'fork-source']].entries()) {
				const options = created[index]!.creationOptions as vscode.TerminalOptions;
				assert.deepStrictEqual(options.shellArgs, args);
				assert.strictEqual(options.shellPath, fakePi);
				assert.strictEqual((options.cwd as vscode.Uri).fsPath, dir);
			}
		} finally {
			vscode.window.terminals.filter(t => !before.has(t)).forEach(t => t.dispose());
		}
	});

	/** Writes a fake `pi` that answers one RPC command with `reply` (`ID` is replaced by the request id). */
	async function fakeRpcPi(reply: string): Promise<string> {
		const script = path.join(dir, 'pi-rpc');
		await fs.writeFile(script, [
			'#!/bin/sh',
			'echo "$@" > "$(dirname "$0")/args.txt"',
			'IFS= read -r line',
			'id=$(printf %s "$line" | sed -n \'s/.*"id":"\\([^"]*\\)".*/\\1/p\')',
			'echo \'{"type":"session_info_changed","name":"x"}\'',
			`printf '%s\\n' '${reply}' | sed "s/ID/$id/"`,
			'cat > /dev/null',
		].join('\n'));
		await fs.chmod(script, 0o755);
		return script;
	}

	test('sendRpcCommand sends a command and returns the matching response', async () => {
		const pi = await fakeRpcPi('{"id":"ID","type":"response","command":"set_session_name","success":true}');
		const result = await sendRpcCommand(pi, '/s/file.jsonl', dir, { type: 'set_session_name', name: 'New' });
		assert.deepStrictEqual(result, { success: true, error: undefined });
		assert.strictEqual((await fs.readFile(path.join(dir, 'args.txt'), 'utf8')).trim(), '--mode rpc --session /s/file.jsonl');
	});

	test('sendRpcCommand reports failures, early exits and timeouts', async () => {
		const failing = await fakeRpcPi('{"id":"ID","type":"response","command":"set_session_name","success":false,"error":"nope"}');
		assert.deepStrictEqual(await sendRpcCommand(failing, 'f', dir, { type: 'x' }), { success: false, error: 'nope' });

		const exiting = path.join(dir, 'pi-exit');
		await fs.writeFile(exiting, '#!/bin/sh\necho boom >&2\nexit 3\n');
		await fs.chmod(exiting, 0o755);
		await assert.rejects(sendRpcCommand(exiting, 'f', dir, { type: 'x' }), /exited \(code 3\).*boom/);

		const silent = path.join(dir, 'pi-silent');
		await fs.writeFile(silent, '#!/bin/sh\nsleep 5\n');
		await fs.chmod(silent, 0o755);
		await assert.rejects(sendRpcCommand(silent, 'f', dir, { type: 'x' }, 200), /did not respond/);
	});
});
