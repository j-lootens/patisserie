import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findPiOnPath, openSessionInTerminal, resolvePiPath } from '../pi/piCli';

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
		const cmd = path.join(dir, 'pi.cmd');
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
});
