import * as vscode from 'vscode';
import { openSessionInTerminal } from './pi/piCli';
import { PiSession } from './sessions/types';
import { SessionTreeProvider } from './views/sessionTreeProvider';

export function activate(context: vscode.ExtensionContext) {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	const provider = new SessionTreeProvider(workspaceRoot);
	const treeView = vscode.window.createTreeView('patisserie.sessions', { treeDataProvider: provider });

	context.subscriptions.push(
		provider,
		treeView,
		vscode.commands.registerCommand('patisserie.refresh', () => provider.refresh()),
		vscode.commands.registerCommand('patisserie.openSession', (session: PiSession) => {
			if (workspaceRoot) {
				return openSessionInTerminal(session, workspaceRoot);
			}
		}),
	);
}

export function deactivate() {}
