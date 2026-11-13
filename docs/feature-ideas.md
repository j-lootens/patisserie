# Feature ideas

This is a list of possible features after FR-1 to FR-19. It comes from:

- a look at VS Code coding-agent extensions: Claude Code, Cline, Kilo Code, and GitHub Copilot agent mode;
- the Pi 1.5.2 docs (`docs/configuration.md`, `skills.md`, `session-format.md`, `message-types.md`, `cli-integration.md`).

Each idea says where the data comes from, so we can see what the session file already gives us.

## 1. Context tab (built, see FR-20 to FR-27)

Finding from the Pi 1.5.2 source: the system prompt in the session records each context file as `<project_instructions path="…">` and each offered skill in `<available_skills>` with its `SKILL.md` location. A `/skill:name` command expands to `<skill name="…" location="…">` in the user message. So these come from the session, not a disk guess. Prompt templates expand into plain text and can't be told apart from typed prompts, so they are listed from disk only.

When the user selects a session, a detail view shows what the agent saw and used in that session. Each item links to its source: a click opens the file or jumps to the entry in the session.

### What to show

| Section | What it shows | Source |
|---|---|---|
| User prompts | Each user message, in order, with its time. A click opens the full text. | `message` entries with `role: "user"` |
| System prompt | The sections of the system prompt (for example `skills`), and how they changed during the session. | `system` messages: `sections`, with later changes as patches. `compaction.systemMessage` holds a full copy. |
| Context files | The `AGENTS.md`, `AGENTS.override.md` and `CLAUDE.md` files that applied: the user-level file in `~/.pi/agent/`, then the workspace root and each parent folder. | The session doesn't name them, so discover them on disk with Pi's rules (`configuration.md` → "Context files"). Mark them "found on disk now", because a file can have changed since the session ran. |
| System prompt files | `SYSTEM.md` and `APPEND_SYSTEM.md`. The project file in `.pi/` replaces the user-level file. | Disk, same rules |
| Skills: available | Skills Pi offered, by name and description. | The `skills` system prompt section, or a disk scan of `~/.pi/agent/skills/`, `.pi/skills/`, `~/.agents/skills/`, and `.agents/skills/` up to the repo root |
| Skills: used | Skills the session actually loaded. | `toolCall` blocks that read a `SKILL.md`, and user messages that start with `/skill:<name>` |
| Prompt templates | Templates used (`/name`), linked to `.pi/prompts/` or `~/.pi/agent/prompts/`. | User messages and the prompt files on disk |
| Files touched | Files read, edited or written, grouped by tool, with counts. A click opens the file. | `toolCall.arguments` (for example `path`) on assistant messages |
| Tools and MCP | Tools available (`toolsAdded`/`toolsRemoved`) and how often each was called. Mark MCP tools. | `system` messages, `toolCall` names, `.pi/mcp.json` and `~/.pi/agent/mcp.json` |
| Extensions | Extensions that may have loaded. | Disk: `~/.pi/agent/extensions/`, `.pi/extensions/` |
| Model and thinking | Model and thinking level over time. | `model_change`, `thinking_level_change`, assistant `model` |
| Compactions | Where context was compacted, the summary, and `tokensBefore`. | `compaction` entries |

### Design notes

- Show the Context tab as a second tree view or a webview panel, opened from a session's context menu ("Show Context"). A tree view is cheaper to build and fits the current view. A webview gives more room for prompt text.
- Keep "recorded in the session" and "found on disk now" apart in the UI.
- Read-only, like the rest of the extension (FR-19).
- Parse the file once and cache the result by file `mtime`, because session files can be large.

## 2. Session detail and history

| Idea | Seen in | Source |
|---|---|---|
| Open a read-only transcript of a session in an editor tab (Markdown or webview). | Claude Code, Cline task history | Session JSONL |
| Export a session to HTML with `pi --export`. | Pi CLI | Command |
| Show token usage per session (input, output, cache) next to cost. | Cline, Kilo context and cost bars | `usage` on assistant messages and `usage` entries |
| Show the model used per session in the list. | Most agents | Last `model_change` or assistant `model` |
| Show the first user prompt as the label when a session has no name. | Pi session picker, Claude Code | First user message |
| Search across sessions: prompt text, file names, tool names. | Claude Code, Cline task history search | Session JSONL |
| Show branches and labels: Pi keeps a tree of entries, so show forks and `label` entries. | Pi `/tree` | `parentId`, `label`, `branch_summary` |
| Group sessions by day, and allow filtering by model or cost. | Cline, Kilo | Derived |

## 3. Actions on sessions

| Idea | Seen in | How |
|---|---|---|
| Continue the latest session (`pi --continue`). | Claude Code `--continue` | Terminal |
| Start a new session, with a name. | All agents | `pi --name <name>` |
| Fork a session into a new one. | Claude Code fork, Pi `--fork` | `pi --fork <id>` |
| Rename a session. | Claude Code, Pi `/name` | Pi owns the file, so this needs Pi's RPC or SDK. It conflicts with FR-19 unless Pi does the write. |
| Reveal the session file in Finder, or copy its ID or path. | — | Commands |
| Bring an already open terminal for a session to the front instead of opening a second one. | — | Track terminals |

## 4. Live integration

| Idea | Seen in | How |
|---|---|---|
| Show running sessions (a live dot) and the current one. | Claude Code, Copilot chat sessions | Watch file `mtime`, or use RPC mode |
| Changed-files view with diffs for each session or turn, opened in VS Code's diff editor. | Cline checkpoints "Compare", Claude Code | Edit and write tool calls; git |
| Checkpoints: restore files to a turn. | Cline (shadow git repo), Claude Code `/rewind` | Needs Pi support or our own snapshots. Large effort. |
| Show context window usage live in the status bar. | Cline, Kilo | RPC `--mode rpc` events |
| Send the editor selection or the current file to a Pi terminal as `@file`. | Claude Code, Copilot `#file` | `terminal.sendText` |

## 5. Configuration helpers

| Idea | Seen in | How |
|---|---|---|
| Resources view: browse and open `AGENTS.md`, skills, prompt templates, extensions and MCP config, with user and project files side by side. | Copilot instructions and prompt files, Cline rules and workflows | Disk, same rules as the Context tab |
| New-skill and new-prompt-template commands with a template file. | Copilot "New prompt file" | Write to `.pi/skills/` or `.pi/prompts/` (these are not session files, so FR-19 doesn't apply) |
| Warn about a malformed `SKILL.md` (missing description). | Pi startup diagnostics | Frontmatter check |

## Suggested order

1. Context tab: user prompts, files touched, skills used, context files (on disk), model.
2. First user prompt as a fallback label, model and token count in the list.
3. Transcript view, then search.
4. Resources view (it reuses the discovery code from the Context tab).
5. Continue, new session and fork actions.
6. Live status and diffs (needs RPC; spike first).

## Open questions

- Does Pi record which `AGENTS.md` files it loaded in the `system` message sections? The session-format docs don't say. Check a real session file before relying on the disk scan.
- Is a skill load always a `read` tool call on `SKILL.md`? Check in a real session.
- How large do session files get? This decides whether we parse on demand or stream the file.

## Sources

- [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing)
- [Claude Code VS Code extension guide (third party)](https://slava-kudzinau.github.io/cc-guide/docs/02-tools-mastery/03-vscode-extension.html)
- [Cline checkpoints](https://docs.cline.bot/features/checkpoints)
- [Kilo vs Roo vs Cline (vendor comparison)](https://kilo.ai/compare/roo-vs-cline-vs-kilo)
- [VS Code context engineering guide](https://code.visualstudio.com/docs/copilot/guides/context-engineering-guide)
- [Copilot custom instructions](https://docs.github.com/en/copilot/how-tos/custom-instructions/adding-repository-custom-instructions-for-github-copilot)
- Pi 1.5.2 docs in the installed package: `configuration.md`, `skills.md`, `session-format.md`, `message-types.md`, `cli-integration.md`
