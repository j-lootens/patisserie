import * as assert from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverResources } from '../context/contextDiscovery';
import { parseSessionContext } from '../context/sessionContext';
import { TextDocumentProvider, buildContextNodes } from '../views/contextTreeProvider';

const CWD = '/work/repo';
const SKILL = '/home/me/.pi/agent/skills/pdf/SKILL.md';

const systemPrompt = [
	'You are Pi.',
	'Project-specific instructions and guidelines:',
	'<project_instructions path="/home/me/.pi/agent/AGENTS.md">\nBe brief.\n</project_instructions>',
	'<project_instructions path="/work/repo/AGENTS.md">\nUse tabs.\n</project_instructions>',
].join('\n\n');

const skillsSection = [
	'<available_skills>',
	'  <skill>',
	'    <name>pdf</name>',
	'    <description>Read &amp; write PDFs</description>',
	`    <location>${SKILL}</location>`,
	'  </skill>',
	'  <skill>',
	'    <name>review</name>',
	'    <description>Review code</description>',
	'    <location>/work/repo/.pi/skills/review/SKILL.md</location>',
	'  </skill>',
	'</available_skills>',
].join('\n');

function line(entry: object): string {
	return JSON.stringify(entry);
}

const sessionText = [
	line({ type: 'session', version: 3, id: 'abc', timestamp: '2026-11-01T10:00:00.000Z', cwd: CWD }),
	line({ type: 'message', id: '1', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'system', content: systemPrompt, sections: { skills: skillsSection }, timestamp: 0 } }),
	line({ type: 'model_change', id: '2', timestamp: '2026-11-01T10:00:01.000Z', provider: 'anthropic', modelId: 'claude-opus-5-5' }),
	line({ type: 'message', id: '3', timestamp: '2026-11-01T10:01:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Fix the bug in src/a.ts' }], timestamp: 0 } }),
	line({ type: 'message', id: '4', timestamp: '2026-11-01T10:01:05.000Z', message: {
		role: 'assistant', provider: 'anthropic', model: 'claude-opus-5-5', timestamp: 0,
		content: [
			{ type: 'thinking', thinking: 'hmm' },
			{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'src/a.ts' } },
			{ type: 'toolCall', id: 't2', name: 'read', arguments: { path: SKILL } },
			{ type: 'toolCall', id: 't3', name: 'edit', arguments: { path: '/work/repo/src/a.ts' } },
			{ type: 'toolCall', id: 't4', name: 'bash', arguments: { command: 'npm test' } },
		],
	} }),
	'not json',
	line({ type: 'message', id: '5', timestamp: '2026-11-01T10:02:00.000Z', message: {
		role: 'user', timestamp: 0,
		content: '<skill name="review" location="/work/repo/.pi/skills/review/SKILL.md">\nReferences are relative to x.\n\nDo a review.\n</skill>\n\nfocus on tests',
	} }),
	line({ type: 'compaction', id: '6', timestamp: '2026-11-01T10:03:00.000Z', summary: 'We fixed a bug.\nMore.', tokensBefore: 12000, firstKeptEntryId: '5' }),
].join('\n');

suite('sessionContext', () => {
	const ctx = parseSessionContext(sessionText);

	test('reads cwd and user prompts, replacing expanded skills', () => {
		assert.strictEqual(ctx.cwd, CWD);
		assert.deepStrictEqual(ctx.prompts.map(p => p.text), ['Fix the bug in src/a.ts', '/skill:review\n\nfocus on tests']);
		assert.strictEqual(ctx.prompts[0].time?.toISOString(), '2026-11-01T10:01:00.000Z');
	});

	test('finds context files and available skills in the system prompt', () => {
		assert.deepStrictEqual(ctx.contextFiles, ['/home/me/.pi/agent/AGENTS.md', '/work/repo/AGENTS.md']);
		assert.deepStrictEqual(ctx.skillsAvailable.map(s => [s.name, s.description]), [['pdf', 'Read & write PDFs'], ['review', 'Review code']]);
	});

	test('finds skills used by read and by command', () => {
		assert.deepStrictEqual(ctx.skillsUsed.map(s => [s.name, s.via]), [['pdf', 'read'], ['review', 'command']]);
		assert.strictEqual(ctx.skillsUsed[0].location, SKILL);
	});

	test('counts files touched, resolving relative paths against cwd', () => {
		const a = ctx.files.find(f => f.path === '/work/repo/src/a.ts');
		assert.deepStrictEqual(a && { reads: a.reads, edits: a.edits, writes: a.writes }, { reads: 1, edits: 1, writes: 0 });
		assert.ok(ctx.files.some(f => f.path === SKILL));
	});

	test('counts tools, models and compactions', () => {
		assert.deepStrictEqual(ctx.tools.map(t => [t.name, t.calls]), [['read', 2], ['bash', 1], ['edit', 1]]);
		assert.deepStrictEqual(ctx.models.map(m => m.model), ['claude-opus-5-5']);
		assert.strictEqual(ctx.compactions[0].tokensBefore, 12000);
	});

	test('empty or invalid input gives an empty context', () => {
		const empty = parseSessionContext('garbage\n{"type":"message"}\n');
		assert.strictEqual(empty.prompts.length, 0);
		assert.strictEqual(empty.cwd, undefined);
	});

	test('buildContextNodes makes sections and opens prompts as documents', () => {
		const disk = { contextFiles: [], systemPromptFiles: [], promptTemplates: [], extensions: [], mcpConfigs: [] };
		const texts = new TextDocumentProvider();
		const nodes = buildContextNodes(ctx, disk, texts);
		assert.deepStrictEqual(nodes.map(n => n.label), [
			'User Prompts', 'Context Files', 'Skills Used', 'Skills Available', 'Files Touched', 'Tools', 'Model', 'Compactions', 'On Disk Now',
		]);
		const prompt = nodes[0].children?.[0];
		assert.strictEqual(prompt?.label, 'Fix the bug in src/a.ts');
		const uri = prompt?.command?.arguments?.[0];
		assert.strictEqual(texts.provideTextDocumentContent(uri), 'Fix the bug in src/a.ts');
		assert.strictEqual(nodes[1].children?.[1].label, 'AGENTS.md');
	});
});

suite('contextDiscovery', () => {
	let root: string;
	let savedAgentDir: string | undefined;

	setup(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'pi-ctx-'));
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
	});

	teardown(async () => {
		if (savedAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		}
		await rm(root, { recursive: true, force: true });
	});

	test('finds context files, system prompt files, templates, extensions and MCP config', async () => {
		const agent = path.join(root, 'agent');
		const repo = path.join(root, 'repo');
		const cwd = path.join(repo, 'pkg');
		await mkdir(path.join(agent, 'prompts'), { recursive: true });
		await mkdir(path.join(cwd, '.pi', 'extensions', 'my-ext'), { recursive: true });
		await writeFile(path.join(agent, 'AGENTS.md'), 'g');
		await writeFile(path.join(agent, 'SYSTEM.md'), 's');
		await writeFile(path.join(agent, 'prompts', 'review.md'), 'r');
		await writeFile(path.join(agent, 'mcp.json'), '{}');
		await writeFile(path.join(repo, 'CLAUDE.md'), 'c');
		await writeFile(path.join(cwd, 'AGENTS.md'), 'a');
		await writeFile(path.join(cwd, 'AGENTS.override.md'), 'o');
		await writeFile(path.join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'x');

		const found = await discoverResources(cwd);
		assert.deepStrictEqual(found.contextFiles, [
			path.join(agent, 'AGENTS.md'),
			path.join(repo, 'CLAUDE.md'),
			path.join(cwd, 'AGENTS.override.md'),
		]);
		assert.deepStrictEqual(found.systemPromptFiles, [path.join(agent, 'SYSTEM.md'), path.join(cwd, '.pi', 'APPEND_SYSTEM.md')]);
		assert.deepStrictEqual(found.promptTemplates, [path.join(agent, 'prompts', 'review.md')]);
		assert.deepStrictEqual(found.extensions, [path.join(cwd, '.pi', 'extensions', 'my-ext')]);
		assert.deepStrictEqual(found.mcpConfigs, [path.join(agent, 'mcp.json')]);
	});
});
