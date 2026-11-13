import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

/** A user prompt from the session. */
export interface PromptInfo {
	/** Prompt text, with expanded skill blocks replaced by `/skill:<name>`. */
	readonly text: string;
	readonly time?: Date;
}

/** A skill that Pi offered to the model (from the system prompt). */
export interface SkillInfo {
	readonly name: string;
	readonly description?: string;
	/** Absolute path to `SKILL.md`. */
	readonly location?: string;
}

/** A skill that the session loaded, by a `read` of `SKILL.md` or a `/skill:name` command. */
export interface UsedSkillInfo extends SkillInfo {
	readonly via: 'read' | 'command';
}

/** A file that tools in the session read, edited or wrote. */
export interface FileInfo {
	/** Absolute path, resolved against the session `cwd`. */
	readonly path: string;
	readonly reads: number;
	readonly edits: number;
	readonly writes: number;
}

export interface ToolInfo {
	readonly name: string;
	readonly calls: number;
}

export interface ModelInfo {
	readonly provider?: string;
	readonly model: string;
	readonly time?: Date;
}

export interface CompactionInfo {
	readonly summary: string;
	readonly tokensBefore?: number;
	readonly time?: Date;
}

/** What a session saw and used. Everything here is recorded in the session file. */
export interface SessionContext {
	readonly cwd?: string;
	readonly prompts: readonly PromptInfo[];
	/** `AGENTS.md`, `CLAUDE.md` and similar files from the system prompt. */
	readonly contextFiles: readonly string[];
	readonly skillsAvailable: readonly SkillInfo[];
	readonly skillsUsed: readonly UsedSkillInfo[];
	readonly files: readonly FileInfo[];
	readonly tools: readonly ToolInfo[];
	readonly models: readonly ModelInfo[];
	readonly compactions: readonly CompactionInfo[];
}

type Json = Record<string, unknown>;

const PROJECT_INSTRUCTIONS = /<project_instructions path="([^"]+)">/g;
const AVAILABLE_SKILL = /<skill>\s*<name>([\s\S]*?)<\/name>\s*(?:<description>([\s\S]*?)<\/description>\s*)?(?:<location>([\s\S]*?)<\/location>)?/g;
const EXPANDED_SKILL = /<skill name="([^"]+)" location="([^"]+)">[\s\S]*?<\/skill>/g;
const READ_TOOLS = new Set(['read']);
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'multi_edit']);
const WRITE_TOOLS = new Set(['write']);

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDate(value: unknown): Date | undefined {
	if (typeof value !== 'string' && typeof value !== 'number') {
		return undefined;
	}
	const d = new Date(value);
	return isNaN(d.getTime()) ? undefined : d;
}

function unescapeXml(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'')
		.replace(/&amp;/g, '&')
		.trim();
}

/** Joins the text of a message `content` (string or content blocks). */
function textOf(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.filter((block): block is Json => isObject(block) && block.type === 'text' && typeof block.text === 'string')
		.map(block => block.text as string)
		.join('\n');
}

function pathArgument(args: unknown): string | undefined {
	if (!isObject(args)) {
		return undefined;
	}
	for (const key of ['path', 'file_path', 'filePath']) {
		const value = args[key];
		if (typeof value === 'string' && value) {
			return value;
		}
	}
	return undefined;
}

/**
 * Parses the text of a session file into its context. Never throws on bad
 * content: malformed lines are skipped.
 */
export function parseSessionContext(text: string): SessionContext {
	let cwd: string | undefined;
	const prompts: PromptInfo[] = [];
	const contextFiles = new Set<string>();
	const skillsAvailable = new Map<string, SkillInfo>();
	const skillsUsed = new Map<string, UsedSkillInfo>();
	const files = new Map<string, { reads: number; edits: number; writes: number }>();
	const tools = new Map<string, number>();
	const models: ModelInfo[] = [];
	const compactions: CompactionInfo[] = [];

	const resolve = (p: string) => (cwd && !path.isAbsolute(p) ? path.resolve(cwd, p) : p);

	const addModel = (model: string, provider: string | undefined, time: Date | undefined) => {
		const last = models[models.length - 1];
		if (!last || last.model !== model || last.provider !== provider) {
			models.push({ model, provider, time });
		}
	};

	const scanSystemText = (systemText: string) => {
		for (const m of systemText.matchAll(PROJECT_INSTRUCTIONS)) {
			contextFiles.add(unescapeXml(m[1]));
		}
		for (const m of systemText.matchAll(AVAILABLE_SKILL)) {
			const name = unescapeXml(m[1]);
			skillsAvailable.set(name, {
				name,
				description: m[2] !== undefined ? unescapeXml(m[2]) : undefined,
				location: m[3] !== undefined ? unescapeXml(m[3]) : undefined,
			});
		}
	};

	const useSkill = (skill: UsedSkillInfo) => {
		if (!skillsUsed.has(skill.name)) {
			skillsUsed.set(skill.name, skill);
		}
	};

	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) {
			continue;
		}
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isObject(entry)) {
			continue;
		}
		const time = toDate(entry.timestamp);

		switch (entry.type) {
			case 'session':
				if (typeof entry.cwd === 'string') {
					cwd = entry.cwd;
				}
				break;
			case 'model_change':
				if (typeof entry.modelId === 'string') {
					addModel(entry.modelId, typeof entry.provider === 'string' ? entry.provider : undefined, time);
				}
				break;
			case 'compaction':
				if (typeof entry.summary === 'string') {
					compactions.push({
						summary: entry.summary,
						tokensBefore: typeof entry.tokensBefore === 'number' ? entry.tokensBefore : undefined,
						time,
					});
				}
				if (isObject(entry.systemMessage)) {
					scanSystemText(systemTextOf(entry.systemMessage));
				}
				break;
			case 'message':
				if (isObject(entry.message)) {
					handleMessage(entry.message, time);
				}
				break;
		}
	}

	function handleMessage(message: Json, time: Date | undefined) {
		switch (message.role) {
			case 'system':
				scanSystemText(systemTextOf(message));
				break;
			case 'user': {
				const raw = textOf(message.content);
				const shown = raw.replace(EXPANDED_SKILL, (_all, name: string, location: string) => {
					useSkill({ name, location, via: 'command', description: skillsAvailable.get(name)?.description });
					return `/skill:${name}`;
				}).trim();
				if (shown) {
					prompts.push({ text: shown, time });
				}
				break;
			}
			case 'assistant': {
				if (typeof message.model === 'string') {
					addModel(message.model, typeof message.provider === 'string' ? message.provider : undefined, time);
				}
				if (!Array.isArray(message.content)) {
					break;
				}
				for (const block of message.content) {
					if (!isObject(block) || block.type !== 'toolCall' || typeof block.name !== 'string') {
						continue;
					}
					const name = block.name;
					tools.set(name, (tools.get(name) ?? 0) + 1);
					const rawPath = pathArgument(block.arguments);
					if (!rawPath) {
						continue;
					}
					const filePath = resolve(rawPath);
					const kind = READ_TOOLS.has(name) ? 'reads' : EDIT_TOOLS.has(name) ? 'edits' : WRITE_TOOLS.has(name) ? 'writes' : undefined;
					if (!kind) {
						continue;
					}
					const counts = files.get(filePath) ?? { reads: 0, edits: 0, writes: 0 };
					counts[kind]++;
					files.set(filePath, counts);
					if (kind === 'reads' && path.basename(filePath) === 'SKILL.md') {
						const known = [...skillsAvailable.values()].find(s => s.location === filePath);
						useSkill({
							name: known?.name ?? path.basename(path.dirname(filePath)),
							description: known?.description,
							location: filePath,
							via: 'read',
						});
					}
				}
				break;
			}
		}
	}

	return {
		cwd,
		prompts,
		contextFiles: [...contextFiles],
		skillsAvailable: [...skillsAvailable.values()].sort((a, b) => a.name.localeCompare(b.name)),
		skillsUsed: [...skillsUsed.values()],
		files: [...files.entries()]
			.map(([p, c]) => ({ path: p, ...c }))
			.sort((a, b) => a.path.localeCompare(b.path)),
		tools: [...tools.entries()]
			.map(([name, calls]) => ({ name, calls }))
			.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
		models,
		compactions,
	};
}

/** Text of a system message: its content plus all named sections. */
function systemTextOf(message: Json): string {
	const parts = [textOf(message.content)];
	if (isObject(message.sections)) {
		for (const value of Object.values(message.sections)) {
			if (typeof value === 'string') {
				parts.push(value);
			}
		}
	}
	return parts.join('\n');
}

/** Reads and parses a session file. Read-only (FR-19). */
export async function readSessionContext(filePath: string): Promise<SessionContext> {
	return parseSessionContext(await readFile(filePath, 'utf8'));
}
