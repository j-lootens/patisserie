import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * A bottom-panel webview with an ASCII beach simulation. Just for fun; it has
 * nothing to do with Pi sessions. The page itself is in `media/beach/`.
 */
export class BeachViewProvider implements vscode.WebviewViewProvider {
	static readonly viewId = 'patisserie.beach';

	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		const media = vscode.Uri.joinPath(this.extensionUri, 'media', 'beach');
		const webview = view.webview;
		webview.options = { enableScripts: true, localResourceRoots: [media] };
		const nonce = randomBytes(16).toString('base64');
		const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'beach.css'));
		const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'beach.js'));
		webview.html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
</head>
<body><pre id="beach"></pre>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
	}
}
