import * as vscode from 'vscode';
import { PiSession } from '../sessions/types';

/** Tree data for the Pi sessions view (FR-1 to FR-11). */
export class SessionTreeProvider implements vscode.TreeDataProvider<PiSession>, vscode.Disposable {
	constructor(private readonly workspaceRoot: vscode.Uri | undefined) {}

	getTreeItem(session: PiSession): vscode.TreeItem {
		throw new Error('Not implemented');
	}

	getChildren(element?: PiSession): Promise<PiSession[]> {
		throw new Error('Not implemented');
	}

	/** Reloads the list (FR-6). */
	refresh(): void {
		throw new Error('Not implemented');
	}

	dispose(): void {}
}
