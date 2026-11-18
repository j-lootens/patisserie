import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// Settings writes and terminals can be slow on a fresh VS Code, such as in CI.
	mocha: { timeout: 10000 },
});
