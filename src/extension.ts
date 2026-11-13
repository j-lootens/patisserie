import * as vscode from 'vscode';
import { continueLatestSession, forkSession, newNamedSession, openSessionInTerminal, renameSession } from './pi/piCli';
import { PiSession } from './sessions/types';
import { BeachViewProvider } from './views/beachView';
import { ContextTreeProvider, TEXT_SCHEME, TextDocumentProvider } from './views/contextTreeProvider';
import { formatCost } from './views/format';
import { SessionTreeProvider } from './views/sessionTreeProvider';

const BEACH_VISIBLE = 'patisserie.beachVisible';

/** Shows or hides the Beach panel. A hidden panel is removed, so its simulation stops. Remembered across restarts. */
async function setBeachVisible(context: vscode.ExtensionContext, visible: boolean): Promise<void> {
	await context.globalState.update(BEACH_VISIBLE, visible);
	await vscode.commands.executeCommand('setContext', BEACH_VISIBLE, visible);
}

export function activate(context: vscode.ExtensionContext) {
	void setBeachVisible(context, context.globalState.get(BEACH_VISIBLE, true));
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	const provider = new SessionTreeProvider(workspaceRoot);
	const treeView = vscode.window.createTreeView('patisserie.sessions', { treeDataProvider: provider });

	const texts = new TextDocumentProvider();
	const contextProvider = new ContextTreeProvider(texts, workspaceRoot);
	const contextView = vscode.window.createTreeView('patisserie.context', { treeDataProvider: contextProvider });

	const showContext = async (session: PiSession | undefined) => {
		await contextProvider.setSession(session);
		contextView.description = session ? session.name || session.id.slice(0, 8) : undefined;
	};

	context.subscriptions.push(
		provider,
		treeView,
		contextProvider,
		contextView,
		vscode.workspace.registerTextDocumentContentProvider(TEXT_SCHEME, texts),
		vscode.window.registerWebviewViewProvider(BeachViewProvider.viewId, new BeachViewProvider(context.extensionUri)),
		vscode.commands.registerCommand('patisserie.openBeach', async () => {
			await setBeachVisible(context, true);
			await vscode.commands.executeCommand(`${BeachViewProvider.viewId}.focus`);
		}),
		vscode.commands.registerCommand('patisserie.closeBeach', () => setBeachVisible(context, false)),
		provider.onDidLoad(({ sessions, totalCost }) => {
			treeView.description = `Total: ${formatCost(totalCost)}`;
			// Keep the Context view in step with the session file (FR-7).
			const current = contextProvider.currentSession;
			if (current) {
				void showContext(sessions.find(s => s.id === current.id));
			}
		}),
		treeView.onDidChangeSelection(e => showContext(e.selection[0])),
		vscode.commands.registerCommand('patisserie.refresh', () => provider.refresh()),
		vscode.commands.registerCommand('patisserie.continueSession', () => {
			if (workspaceRoot) {
				return continueLatestSession(workspaceRoot);
			}
			void vscode.window.showWarningMessage('Open a workspace folder to continue a Pi session.');
		}),
		vscode.commands.registerCommand('patisserie.newSession', () => {
			if (workspaceRoot) {
				return newNamedSession(workspaceRoot);
			}
			void vscode.window.showWarningMessage('Open a workspace folder to start a Pi session.');
		}),
		vscode.commands.registerCommand('patisserie.forkSession', (session?: PiSession) => {
			const target = session ?? treeView.selection[0];
			if (target && workspaceRoot) {
				return forkSession(target, workspaceRoot);
			}
		}),
		vscode.commands.registerCommand('patisserie.openSession', async (session: PiSession) => {
			// Bring an open terminal to the front instead of starting Pi twice on one session.
			const open = provider.terminalFor(session.id);
			if (open) {
				open.show();
				return;
			}
			if (workspaceRoot) {
				const terminal = await openSessionInTerminal(session, workspaceRoot);
				if (terminal) {
					provider.trackTerminal(session.id, terminal);
				}
			}
		}),
		vscode.commands.registerCommand('patisserie.renameSession', async (session?: PiSession) => {
			const target = session ?? treeView.selection[0];
			if (target && workspaceRoot && await renameSession(target, workspaceRoot)) {
				provider.refresh();
			}
		}),
		vscode.commands.registerCommand('patisserie.showContext', async (session: PiSession) => {
			await showContext(session);
			await vscode.commands.executeCommand('patisserie.context.focus');
		}),
	);
}

export function deactivate() {}
