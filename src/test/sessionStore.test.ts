import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WAITING_RECENT_MS, buildSessionForest, WORKING_STALE_MS, encodeCwd, getSessionDir, listSessions, parseSessionFile, sessionStatus } from '../sessions/sessionStore';

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
		test('renames and setting changes do not count as activity', async () => {
			const f = path.join(tmp, 'r.jsonl');
			await fs.writeFile(f, jsonl(
				header('abc', '2026-01-01T10:00:00.000Z'),
				{ type: 'message', timestamp: '2026-01-01T11:00:00.000Z', message: { role: 'user', content: 'hi' } },
				{ type: 'thinking_level_change', timestamp: '2026-01-05T00:00:00.000Z', thinkingLevel: 'off' },
				{ type: 'session_info', timestamp: '2026-01-05T00:00:00.000Z', name: 'Renamed' },
			));
			const s = await parseSessionFile(f);
			assert.strictEqual(s?.name, 'Renamed');
			assert.strictEqual(s?.lastActivity.toISOString(), '2026-01-01T11:00:00.000Z');
		});
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

suite('sessionStatus', () => {
	let tmp: string;

	setup(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'patisserie-status-'));
	});

	teardown(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	async function parseLast(message: object) {
		const file = path.join(tmp, 's.jsonl');
		await fs.writeFile(file, jsonl(
			header('s', '2026-11-01T10:00:00.000Z'),
			{ type: 'message', timestamp: '2026-11-01T10:00:01.000Z', message: { role: 'user', content: 'hi' } },
			{ type: 'message', timestamp: '2026-11-01T10:00:02.000Z', message },
			{ type: 'session_info', timestamp: '2026-11-01T10:00:03.000Z', name: 'renamed' },
		));
		const session = await parseSessionFile(file);
		assert.ok(session);
		return session;
	}

	test('agent turn: tool calls and tool results, but not a finished answer', async () => {
		assert.strictEqual((await parseLast({ role: 'assistant', stopReason: 'toolUse' })).agentTurn, true);
		assert.strictEqual((await parseLast({ role: 'toolResult' })).agentTurn, true);
		assert.strictEqual((await parseLast({ role: 'assistant', stopReason: 'stop' })).agentTurn, false);
	});

	test('working, waiting and inactive by age and open terminal', async () => {
		const busy = await parseLast({ role: 'toolResult' });
		const done = await parseLast({ role: 'assistant', stopReason: 'stop' });
		const t = busy.lastActivity.getTime();
		assert.strictEqual(sessionStatus(busy, t + 1000), 'working');
		assert.strictEqual(sessionStatus(busy, t + WORKING_STALE_MS + 1), 'inactive');
		assert.strictEqual(sessionStatus(busy, t + WORKING_STALE_MS + 1, true), 'waiting');
		assert.strictEqual(sessionStatus(done, t + 1000), 'waiting');
		assert.strictEqual(sessionStatus(done, t + WAITING_RECENT_MS + 1), 'inactive');
		assert.strictEqual(sessionStatus(done, t + WAITING_RECENT_MS + 1, true), 'waiting');
	});
});

suite('buildSessionForest', () => {
	const at = (id: string, parentSession?: string) => ({
		id, filePath: `/s/${id}.jsonl`, startTime: new Date(0), lastActivity: new Date(0), parentSession,
	});

	test('nests forks under their parent and keeps orphans as roots', () => {
		const forest = buildSessionForest([
			at('fork2', '/s/fork1.jsonl'),
			at('fork1', '/s/root.jsonl'),
			at('orphan', '/gone/x.jsonl'),
			at('root'),
		]);
		assert.deepStrictEqual(forest.get(undefined)?.map(s => s.id), ['orphan', 'root']);
		assert.deepStrictEqual(forest.get('root')?.map(s => s.id), ['fork1']);
		assert.deepStrictEqual(forest.get('fork1')?.map(s => s.id), ['fork2']);
	});
});

suite('fork cost', () => {
	let tmp: string;
	let saved: string | undefined;

	setup(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'patisserie-fork-'));
		saved = process.env.PI_CODING_AGENT_SESSION_DIR;
		process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
	});

	teardown(async () => {
		if (saved === undefined) {
			delete process.env.PI_CODING_AGENT_SESSION_DIR;
		} else {
			process.env.PI_CODING_AGENT_SESSION_DIR = saved;
		}
		await fs.rm(tmp, { recursive: true, force: true });
	});

	test('a fork does not count the entries it copied from its parent', async () => {
		const paid = (id: string, total: number) => ({
			type: 'message', id, timestamp: '2026-11-01T10:00:01.000Z', message: { role: 'assistant', usage: { cost: { total } } },
		});
		const parentFile = path.join(tmp, 'a_parent.jsonl');
		await fs.writeFile(parentFile, jsonl(header('parent', '2026-11-01T10:00:00.000Z'), paid('m1', 1), paid('m2', 2)));
		await fs.writeFile(path.join(tmp, 'b_fork.jsonl'), jsonl(
			{ ...header('fork', '2026-11-01T11:00:00.000Z'), parentSession: parentFile },
			paid('m1', 1), paid('m2', 2), paid('m3', 0.5),
		));
		const sessions = await listSessions('/ws');
		const fork = sessions.find(s => s.id === 'fork');
		assert.strictEqual(fork?.cost, 0.5);
		assert.strictEqual(fork?.inheritedCost, 3);
		assert.strictEqual(sessions.find(s => s.id === 'parent')?.cost, 3);
	});
});
