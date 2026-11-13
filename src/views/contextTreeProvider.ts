import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DiskResources, discoverResources } from '../context/contextDiscovery';
import { SessionContext, readSessionContext } from '../context/sessionContext';
import { PiSession } from '../sessions/types';

/** URI scheme for read-only documents that show a prompt or summary text. */
export const TEXT_SCHEME = 'patisserie-text';

/** A node in the Context view: a section or a leaf item. */
export interface ContextNode {
	readonly label: string;
	readonly description?: string;
	readonly tooltip?: string | vscode.MarkdownString;
	readonly icon?: string;
	readonly resourceUri?: vscode.Uri;
	readonly command?: vscode.Command;
	readonly children?: readonly ContextNode[];
	readonly expanded?: boolean;
}

/** Serves the text behind `patisserie-text:` URIs as read-only documents. */
export class TextDocumentProvider implements vscode.TextDocumentContentProvider {
	private readonly texts = new Map<string, string>();
	private next = 0;

	/** Stores `text` and returns a URI that shows it, titled `title`. */
	register(title: string, text: string): vscode.Uri {
		const key = String(this.next++);
		this.texts.set(key, text);
		const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-');
		return vscode.Uri.from({ scheme: TEXT_SCHEME, path: `/${safeTitle}.md`, query: key });
	}

	clear(): void {
		this.texts.clear();
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.texts.get(uri.query) ?? '';
	}
}

function tildify(filePath: string): string {
	const home = os.homedir();
	return filePath === home || filePath.startsWith(home + path.sep) ? `~${filePath.slice(home.length)}` : filePath;
}

function openFile(filePath: string): vscode.Command {
	return { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(filePath)] };
}

function fileNode(filePath: string, cwd: string | undefined, description?: string, tooltip?: string): ContextNode {
	const relative = cwd ? path.relative(cwd, filePath) : '';
	const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
	return {
		label: inside ? relative : tildify(filePath),
		description,
		tooltip: tooltip ?? filePath,
		resourceUri: vscode.Uri.file(filePath),
		command: openFile(filePath),
	};
}

function section(label: string, icon: string, children: ContextNode[], empty: string, expanded = false): ContextNode {
	return {
		label,
		icon,
		description: String(children.length),
		children: children.length ? children : [{ label: empty, icon: 'circle-slash' }],
		expanded,
	};
}

function firstLine(text: string, max = 80): string {
	const line = text.split('\n').find(l => l.trim())?.trim() ?? '';
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Builds the Context view tree. Pure apart from creating text URIs. */
export function buildContextNodes(ctx: SessionContext, disk: DiskResources, texts: TextDocumentProvider): ContextNode[] {
	const cwd = ctx.cwd;

	// Most recent prompt first (FR-21); numbers keep the order they were sent in.
	const prompts = ctx.prompts.map((p, i): ContextNode => {
		const uri = texts.register(`Prompt ${i + 1}`, p.text);
		return {
			label: firstLine(p.text),
			description: p.time?.toLocaleTimeString(),
			tooltip: new vscode.MarkdownString().appendCodeblock(p.text.slice(0, 2000), 'markdown'),
			icon: 'comment',
			command: { command: 'vscode.open', title: 'Show Prompt', arguments: [uri, { preview: true }] },
		};
	}).reverse();

	// Context files recorded in the system prompt win; older sessions fall back to the disk scan.
	const recordedContext = ctx.contextFiles.length > 0;
	const contextFiles = (recordedContext ? ctx.contextFiles : disk.contextFiles)
		.map(f => fileNode(f, cwd, recordedContext ? undefined : 'on disk now'));

	const skillsUsed = ctx.skillsUsed.map((s): ContextNode => ({
		...(s.location ? fileNode(s.location, cwd) : {}),
		label: s.name,
		description: s.via === 'command' ? `/skill:${s.name}` : 'loaded by model',
		tooltip: s.description ?? s.location,
		icon: 'zap',
	}));

	const usedNames = new Set(ctx.skillsUsed.map(s => s.name));
	const skillsAvailable = ctx.skillsAvailable.map((s): ContextNode => ({
		...(s.location ? fileNode(s.location, cwd) : {}),
		label: s.name,
		description: usedNames.has(s.name) ? 'used' : s.description && firstLine(s.description, 60),
		tooltip: s.description ?? s.location,
		icon: usedNames.has(s.name) ? 'zap' : 'book',
	}));

	const files = ctx.files.map(f => {
		const parts = [f.reads && `${f.reads}R`, f.edits && `${f.edits}E`, f.writes && `${f.writes}W`].filter(Boolean);
		const tip = [plural(f.reads, 'read'), plural(f.edits, 'edit'), plural(f.writes, 'write')].join(', ');
		return fileNode(f.path, cwd, parts.join(' '), `${f.path}\n${tip}`);
	});

	const tools = ctx.tools.map((t): ContextNode => ({
		label: t.name,
		description: plural(t.calls, 'call'),
		icon: t.name.startsWith('mcp') || t.name.includes('__') ? 'plug' : 'tools',
	}));

	const models = ctx.models.map((m): ContextNode => ({
		label: m.model,
		description: [m.provider, m.time?.toLocaleTimeString()].filter(Boolean).join(' · '),
		icon: 'hubot',
	}));

	const compactions = ctx.compactions.map((c, i): ContextNode => {
		const uri = texts.register(`Compaction ${i + 1}`, c.summary);
		return {
			label: firstLine(c.summary),
			description: c.tokensBefore !== undefined ? `${c.tokensBefore.toLocaleString()} tokens before` : undefined,
			icon: 'fold',
			command: { command: 'vscode.open', title: 'Show Summary', arguments: [uri, { preview: true }] },
		};
	});

	const onDisk: ContextNode[] = [
		section('System Prompt Files', 'file-code', disk.systemPromptFiles.map(f => fileNode(f, cwd)), 'None'),
		section('Prompt Templates', 'symbol-snippet', disk.promptTemplates.map(f => fileNode(f, cwd, `/${path.basename(f, '.md')}`)), 'None'),
		section('Extensions', 'extensions', disk.extensions.map(f => fileNode(f, cwd)), 'None'),
		section('MCP Config', 'plug', disk.mcpConfigs.map(f => fileNode(f, cwd)), 'None'),
	];

	return [
		section('User Prompts', 'comment-discussion', prompts, 'No prompts', true),
		section('Context Files', 'book', contextFiles, 'No AGENTS.md or CLAUDE.md', true),
		section('Skills Used', 'zap', skillsUsed, 'No skills used', true),
		section('Skills Available', 'library', skillsAvailable, 'No skills offered'),
		section('Files Touched', 'files', files, 'No files read or changed'),
		section('Tools', 'tools', tools, 'No tool calls'),
		section('Model', 'hubot', models, 'Unknown'),
		...(compactions.length ? [section('Compactions', 'fold', compactions, '')] : []),
		{
			label: 'On Disk Now',
			icon: 'folder',
			tooltip: 'Pi files found on disk now. They are not recorded in the session, so they may have changed since it ran.',
			children: onDisk,
		},
	];
}

/** Tree data for the Context view: what the selected session saw and used. */
export class ContextTreeProvider implements vscode.TreeDataProvider<ContextNode>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<ContextNode | undefined | void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	private session: PiSession | undefined;
	private nodes: ContextNode[] = [];
	private loadedMtime = 0;
	private loading: Promise<void> | undefined;

	constructor(
		private readonly texts: TextDocumentProvider,
		private readonly workspaceRoot: vscode.Uri | undefined,
	) {}

	get currentSession(): PiSession | undefined {
		return this.session;
	}

	/** Shows the context of `session`, or clears the view. */
	setSession(session: PiSession | undefined): Promise<void> {
		if (session?.filePath !== this.session?.filePath) {
			this.loadedMtime = 0;
		}
		this.session = session;
		return this.reload();
	}

	/** Re-reads the current session if its file changed. */
	reload(): Promise<void> {
		this.loading = this.load().catch(err => {
			console.error('patisserie: failed to read session context', err);
			this.nodes = [{ label: 'Could not read this session', icon: 'error', tooltip: String(err) }];
			this.changeEmitter.fire();
		});
		return this.loading;
	}

	private async load(): Promise<void> {
		const session = this.session;
		if (!session) {
			this.nodes = [];
			this.texts.clear();
			this.changeEmitter.fire();
			return;
		}
		const mtime = (await stat(session.filePath)).mtimeMs;
		if (mtime === this.loadedMtime) {
			return;
		}
		const ctx = await readSessionContext(session.filePath);
		const cwd = ctx.cwd ?? this.workspaceRoot?.fsPath;
		const disk = cwd
			? await discoverResources(cwd)
			: { contextFiles: [], systemPromptFiles: [], promptTemplates: [], extensions: [], mcpConfigs: [] };
		if (this.session !== session) {
			return;
		}
		this.texts.clear();
		this.nodes = buildContextNodes({ ...ctx, cwd }, disk, this.texts);
		this.loadedMtime = mtime;
		this.changeEmitter.fire();
	}

	getTreeItem(node: ContextNode): vscode.TreeItem {
		const state = node.children
			? node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
			: vscode.TreeItemCollapsibleState.None;
		const item = new vscode.TreeItem(node.label, state);
		item.description = node.description;
		item.tooltip = node.tooltip;
		item.command = node.command;
		if (node.resourceUri) {
			item.resourceUri = node.resourceUri;
		}
		if (node.icon) {
			item.iconPath = new vscode.ThemeIcon(node.icon);
		}
		return item;
	}

	getChildren(node?: ContextNode): ContextNode[] {
		return node ? [...(node.children ?? [])] : this.nodes;
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}
}
