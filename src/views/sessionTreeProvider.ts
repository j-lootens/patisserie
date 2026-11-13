import * as vscode from 'vscode';
import { PiSession, SessionStatus } from '../sessions/types';
import { getSessionDir, listSessions, sessionStatus } from '../sessions/sessionStore';
import { formatCost, totalCost } from './format';

export interface SessionsLoadedEvent {
	readonly sessions: readonly PiSession[];
	/** Sum of known costs, `undefined` when no session has a cost. */
	readonly totalCost: number | undefined;
}

const DEBOUNCE_MS = 300;
/** How often statuses are recomputed, so they age without file changes. */
const STATUS_TICK_MS = 30_000;

const STATUS_ICONS: Record<SessionStatus, vscode.ThemeIcon> = {
	working: new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue')),
	waiting: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow')),
	inactive: new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground')),
};
const STATUS_LABELS: Record<SessionStatus, string> = {
	working: 'Working',
	waiting: 'Waiting for input',
	inactive: 'Inactive',
};

/** Tree data for the Pi sessions view (FR-1 to FR-11). */
export class SessionTreeProvider implements vscode.TreeDataProvider<PiSession>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<PiSession | undefined | void>();
	private readonly loadEmitter = new vscode.EventEmitter<SessionsLoadedEvent>();
	readonly onDidChangeTreeData = this.changeEmitter.event;
	/** Fires after every load; use it to update the TreeView description (FR-11). */
	readonly onDidLoad = this.loadEmitter.event;

	private watcher: vscode.FileSystemWatcher | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private errorShown = false;
	private disposed = false;
	/** Terminals the extension opened, by session ID. */
	private readonly terminals = new Map<string, vscode.Terminal>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly workspaceRoot: vscode.Uri | undefined) {
		void this.startWatching();
		const tick = setInterval(() => this.refresh(), STATUS_TICK_MS);
		this.disposables.push(
			{ dispose: () => clearInterval(tick) },
			vscode.window.onDidCloseTerminal(closed => {
				for (const [id, terminal] of this.terminals) {
					if (terminal === closed) {
						this.terminals.delete(id);
						this.refresh();
					}
				}
			}),
		);
	}

	/** The open terminal for a session, if the extension opened one. */
	terminalFor(sessionId: string): vscode.Terminal | undefined {
		return this.terminals.get(sessionId);
	}

	/** Remembers that `terminal` runs `sessionId`, so the session shows as live (FR-31). */
	trackTerminal(sessionId: string, terminal: vscode.Terminal): void {
		this.terminals.set(sessionId, terminal);
		this.refresh();
	}

	getTreeItem(session: PiSession): vscode.TreeItem {
		const item = new vscode.TreeItem(session.name || session.id, vscode.TreeItemCollapsibleState.None);
		item.id = session.id;
		item.contextValue = 'session';
		const status = sessionStatus(session, Date.now(), this.terminals.has(session.id));
		item.description = status === 'inactive' ? formatCost(session.cost) : `${STATUS_LABELS[status]} · ${formatCost(session.cost)}`;
		item.iconPath = STATUS_ICONS[status];
		const tip = new vscode.MarkdownString(undefined, true);
		tip.appendMarkdown(`**${escapeMd(session.name || session.id)}**\n\n`);
		tip.appendMarkdown(`Status: ${STATUS_LABELS[status]}\n\n`);
		tip.appendMarkdown(`ID: \`${session.id}\`\n\n`);
		tip.appendMarkdown(`Started: ${session.startTime.toLocaleString()}\n\n`);
		tip.appendMarkdown(`Last activity: ${session.lastActivity.toLocaleString()}\n\n`);
		tip.appendMarkdown(`Cost: ${formatCost(session.cost)}`);
		item.tooltip = tip;
		item.command = { command: 'patisserie.openSession', title: 'Open Session', arguments: [session] };
		return item;
	}

	async getChildren(element?: PiSession): Promise<PiSession[]> {
		if (element || !this.workspaceRoot) {
			return [];
		}
		try {
			const sessions = await listSessions(this.workspaceRoot.fsPath);
			this.errorShown = false;
			this.loadEmitter.fire({ sessions, totalCost: totalCost(sessions) });
			return sessions;
		} catch (err) {
			console.error('patisserie: failed to list Pi sessions', err);
			if (!this.errorShown) {
				this.errorShown = true;
				void vscode.window.showErrorMessage(`Patisserie: could not read Pi sessions (${err instanceof Error ? err.message : String(err)}).`);
			}
			this.loadEmitter.fire({ sessions: [], totalCost: undefined });
			return [];
		}
	}

	/** Reloads the list (FR-6). */
	refresh(): void {
		this.changeEmitter.fire();
	}

	private async startWatching(): Promise<void> {
		if (!this.workspaceRoot) {
			return;
		}
		try {
			const dir = await getSessionDir(this.workspaceRoot.fsPath);
			if (this.disposed) {
				return;
			}
			this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*.jsonl'));
			const schedule = () => this.scheduleRefresh();
			this.watcher.onDidCreate(schedule);
			this.watcher.onDidChange(schedule);
			this.watcher.onDidDelete(schedule);
		} catch (err) {
			console.error('patisserie: could not watch the Pi session dir', err);
		}
	}

	private scheduleRefresh(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.refresh(), DEBOUNCE_MS);
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.watcher?.dispose();
		this.disposables.forEach(d => d.dispose());
		this.changeEmitter.dispose();
		this.loadEmitter.dispose();
	}
}

function escapeMd(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
