import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeCwd, getSessionDir, listSessions, parseSessionFile } from '../sessions/sessionStore';

const ENV_KEYS = ['PI_CODING_AGENT_SESSION_DIR', 'PI_CODING_AGENT_DIR'] as const;

function jsonl(...entries: unknown[]): string {
	return entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
}

function header(id: string, ts: string, cwd = '/ws') {
	return { type: 'session', version: 3, id, timestamp: ts, cwd };
}

suite('sessionStore', () => {
	let tmp: string;
	const saved: Record<string, string | undefined> = {};

	setup(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'patisserie-'));
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
		process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'agent');
	});

	teardown(async () => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = saved[k];
			}
		}
		await fs.rm(tmp, { recursive: true, force: true });
	});

	suite('encodeCwd', () => {
		test('POSIX path', () => {
			assert.strictEqual(encodeCwd('/Users/me/patisserie'), '--Users-me-patisserie--');
		});
		test('Windows path', () => {
			assert.strictEqual(encodeCwd('C:\\a\\b'), '--C--a-b--');
		});
		test('strips only one leading separator', () => {
			assert.strictEqual(encodeCwd('//x'), '---x--');
		});
	});

	suite('getSessionDir', () => {
		test('default uses agent dir and encoded cwd', async () => {
			assert.strictEqual(await getSessionDir('/ws/a'), path.join(tmp, 'agent', 'sessions', '--ws-a--'));
		});
		test('settings sessionDir is used as-is', async () => {
			await fs.mkdir(path.join(tmp, 'agent'), { recursive: true });
			await fs.writeFile(path.join(tmp, 'agent', 'settings.json'), JSON.stringify({ sessionDir: '~/custom' }));
			assert.strictEqual(await getSessionDir('/ws/a'), path.join(os.homedir(), 'custom'));
		});
		test('env var beats settings', async () => {
			await fs.mkdir(path.join(tmp, 'agent'), { recursive: true });
			await fs.writeFile(path.join(tmp, 'agent', 'settings.json'), JSON.stringify({ sessionDir: '/from/settings' }));
			process.env.PI_CODING_AGENT_SESSION_DIR = '/from/env';
			assert.strictEqual(await getSessionDir('/ws/a'), '/from/env');
		});
		test('invalid settings file falls back to default', async () => {
			await fs.mkdir(path.join(tmp, 'agent'), { recursive: true });
			await fs.writeFile(path.join(tmp, 'agent', 'settings.json'), '{nope');
			assert.strictEqual(await getSessionDir('/ws'), path.join(tmp, 'agent', 'sessions', '--ws--'));
		});
	});

	suite('parseSessionFile', () => {
		test('parses name, times and cost', async () => {
			const f = path.join(tmp, 's.jsonl');
			await fs.writeFile(f, jsonl(
				header('abc', '2026-01-01T10:00:00.000Z'),
				{ type: 'session_info', name: 'first', timestamp: '2026-01-01T10:01:00.000Z' },
				{ type: 'message', timestamp: '2026-01-01T10:05:00.000Z', message: { usage: { cost: { total: 0.25 } } } },
				{ type: 'x', timestamp: '2026-01-01T10:06:00.000Z', usage: { cost: { total: 0.5 } } },
				{ type: 'session_info', name: 'second', timestamp: '2026-01-01T10:02:00.000Z' },
			));
			const s = await parseSessionFile(f);
			assert.ok(s);
			assert.strictEqual(s.id, 'abc');
			assert.strictEqual(s.name, 'second');
			assert.strictEqual(s.filePath, f);
			assert.strictEqual(s.startTime.toISOString(), '2026-01-01T10:00:00.000Z');
			assert.strictEqual(s.lastActivity.toISOString(), '2026-01-01T10:06:00.000Z');
			assert.strictEqual(s.cost, 0.75);
		});
		test('no cost gives undefined, no name gives undefined', async () => {
			const f = path.join(tmp, 's.jsonl');
			await fs.writeFile(f, jsonl(header('a', '2026-01-01T10:00:00.000Z'), { type: 'message', message: {} }));
			const s = await parseSessionFile(f);
			assert.ok(s);
			assert.strictEqual(s.cost, undefined);
			assert.strictEqual(s.name, undefined);
			assert.strictEqual(s.lastActivity.toISOString(), s.startTime.toISOString());
		});
		test('skips malformed lines and bad timestamps', async () => {
			const f = path.join(tmp, 's.jsonl');
			await fs.writeFile(f, jsonl(
				header('a', '2026-01-01T10:00:00.000Z'),
				'{not json',
				'',
				{ type: 'message', timestamp: 'garbage', message: { usage: { cost: { total: 'x' } } } },
				{ type: 'message', timestamp: '2026-01-01T11:00:00.000Z', message: { usage: { cost: { total: 1 } } } },
			));
			const s = await parseSessionFile(f);
			assert.ok(s);
			assert.strictEqual(s.cost, 1);
			assert.strictEqual(s.lastActivity.toISOString(), '2026-01-01T11:00:00.000Z');
		});
		test('bad header returns undefined', async () => {
			const cases = ['', 'garbage', jsonl({ type: 'message', id: 'a' }), jsonl({ type: 'session', timestamp: '2026-01-01T00:00:00Z' })];
			for (const [i, c] of cases.entries()) {
				const f = path.join(tmp, `b${i}.jsonl`);
				await fs.writeFile(f, c);
				assert.strictEqual(await parseSessionFile(f), undefined, `case ${i}`);
			}
		});
		test('missing file returns undefined', async () => {
			assert.strictEqual(await parseSessionFile(path.join(tmp, 'nope.jsonl')), undefined);
		});
	});

	suite('listSessions', () => {
		test('missing dir gives empty list', async () => {
			assert.deepStrictEqual(await listSessions('/ws'), []);
		});
		test('sorts by last activity descending, ignores non-jsonl and invalid files', async () => {
			const dir = path.join(tmp, 'agent', 'sessions', '--ws--');
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, 'a.jsonl'), jsonl(header('old', '2026-01-01T00:00:00.000Z')));
			await fs.writeFile(path.join(dir, 'b.jsonl'), jsonl(header('new', '2026-01-03T00:00:00.000Z')));
			await fs.writeFile(path.join(dir, 'c.jsonl'), jsonl(header('mid', '2026-01-02T00:00:00.000Z')));
			await fs.writeFile(path.join(dir, 'd.jsonl'), 'junk');
			await fs.writeFile(path.join(dir, 'e.txt'), 'x');
			assert.deepStrictEqual((await listSessions('/ws')).map((s) => s.id), ['new', 'mid', 'old']);
		});
		test('custom dir is used as-is and filtered by header cwd', async () => {
			const dir = path.join(tmp, 'shared');
			await fs.mkdir(dir);
			process.env.PI_CODING_AGENT_SESSION_DIR = dir;
			await fs.writeFile(path.join(dir, 'a.jsonl'), jsonl(header('mine', '2026-01-01T00:00:00.000Z', '/ws')));
			await fs.writeFile(path.join(dir, 'b.jsonl'), jsonl(header('other', '2026-01-02T00:00:00.000Z', '/elsewhere')));
			assert.deepStrictEqual((await listSessions('/ws')).map((s) => s.id), ['mine']);
		});
	});
});
