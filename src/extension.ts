import * as vscode from 'vscode';
import { continueLatestSession, forkSession, newNamedSession, openSessionInTerminal, renameSession } from './pi/piCli';
import { PiSession } from './sessions/types';
import { ContextTreeProvider, TEXT_SCHEME, TextDocumentProvider } from './views/contextTreeProvider';
import { formatCost } from './views/format';
import { SessionTreeProvider } from './views/sessionTreeProvider';

export function activate(context: vscode.ExtensionContext) {
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
