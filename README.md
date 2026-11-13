# patisserie

A VS Code extension to manage [Pi](https://github.com/badlogic/pi-mono) coding agent sessions.

- **Pi Sessions view** (activity bar, pie icon): the sessions of the open workspace, with status (working, waiting for input, inactive), cost, and forks nested under their parent. Click a session to resume it in a terminal. Rename it with F2, fork it, or start a new or continued session from the title bar.
- **Context view**: what a session used — user prompts, context files, skills, files touched, tools, models and compactions.
- **Beach** (bottom panel): an ASCII beach to look at while Pi works. You can draw in the sand.

The extension reads session files only. Changes, such as a rename, go through the Pi CLI.

See [docs/requirements.md](docs/requirements.md) for the functional requirements and [docs/feature-ideas.md](docs/feature-ideas.md) for possible next features.

## Development

```bash
npm install
npm run compile
npm test
```

Press F5 in VS Code to start an Extension Development Host.

To package the extension and install it into your VS Code:

```bash
npm run install-local
```

Then run **Developer: Restart Extension Host** in VS Code to load the new version.
