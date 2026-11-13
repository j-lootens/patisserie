# Functional requirements: Pi session manager (VS Code extension)

## Session list

- **FR-1.** The extension must show a list of the Pi sessions that belong to the open workspace. These are the `*.jsonl` files in the session directory for the workspace root (see [Pi session storage](#pi-session-storage)).
- **FR-2.** The extension must show the list in a view in the activity bar.
- **FR-3.** For each session, the list must show the session name or ID, the start time, and the last activity time.
- **FR-4.** The extension must sort the list by last activity, with the newest session first.
- **FR-5.** If the workspace has no sessions, the view must show the message "No Pi sessions for this workspace."
- **FR-6.** The view must have a Refresh button that loads the list again.
- **FR-7.** If the Pi CLI makes a new session in the workspace, the list must update without a manual refresh.

## Cost

- **FR-8.** For each session, the list must show the total cost of the session. The total cost is the sum of all `message.usage.cost.total` and `usage.cost.total` values in the session file.
- **FR-9.** The extension must show the cost in USD with two decimal places.
- **FR-10.** If the cost data for a session is not available, the list must show "–" instead of a value.
- **FR-11.** The view must show the total cost of all sessions in the workspace.

## Open in terminal

- **FR-12.** If the user clicks a session, the extension must open a new VS Code terminal.
- **FR-13.** The extension must start the Pi CLI in that terminal and resume the selected session with `pi --session <session-id>`.
- **FR-14.** The terminal must use the workspace root as its working directory.
- **FR-15.** The terminal name must include the session name or ID.

## Pi CLI integration

- **FR-16.** The extension must find the Pi CLI on the system `PATH`.
- **FR-17.** The user must be able to set a different path to the Pi CLI in the extension settings.
- **FR-18.** If the extension cannot find the Pi CLI, it must show an error message with a link to the settings.
- **FR-19.** The extension must read session data in read-only mode. It must not change or delete session files. Changes to a session (FR-28) must go through the Pi CLI, which writes the file.

## Session actions

- **FR-36.** The session list title bar must have a "New Named Session" button. The extension must ask for a name and start `pi --name <name>` in a new terminal in the workspace root.
- **FR-37.** The session list title bar must have a "Continue Latest Session" button that starts `pi --continue` in a new terminal in the workspace root.
- **FR-38.** The context menu of a session must have "Fork Session in Terminal", which starts `pi --fork <session-id>` in a new terminal in the workspace root.

## Rename

- **FR-28.** The user must be able to rename a session from the session's context menu or with F2 in the session list. The extension must ask for the new name, prefilled with the current name, and store it with Pi's RPC command `set_session_name` (`pi --mode rpc --session <file>`). If Pi fails or doesn't answer within 15 seconds, the extension must show an error.
- **FR-29.** Renaming must not change the session's last activity time. Entries that only change settings (`session_info`, `label`, `thinking_level_change`, `model_change`) don't count as activity.

## Session status

- **FR-30.** The session list must show the status of each session with an icon, a label and a tooltip line:
  - **Working**: the last message leaves the turn to the agent (a user message, a tool result, or an assistant message with `stopReason: "toolUse"`), and the session file changed in the last 5 minutes.
  - **Waiting for input**: the agent finished its turn, and the extension has an open terminal for the session or the session changed in the last 15 minutes.
  - **Inactive**: all other sessions, including an agent turn with no change for 5 minutes (Pi stopped or crashed).
- **FR-31.** Pi doesn't keep the session file open, so the extension can't match a running Pi process to its session. It must treat a session that it opened in a terminal as live until the terminal closes. Clicking a session with an open terminal must show that terminal instead of starting Pi again.
- **FR-32.** The list must recompute statuses every 30 seconds, so they change with time even when no file changes.

## Forks

- **FR-33.** The session list must show forks as a tree. A fork is listed under the session it was forked from, which Pi records as the file path in the header field `parentSession`. Forks of forks nest further. A fork whose parent is not in the list (deleted, or in another workspace) is shown at the top level. Each level is sorted by last activity (FR-4).
- **FR-34.** The tooltip must show the parent session ("Forked from") and the number of direct forks.
- **FR-35.** A fork starts with a copy of its parent's entries, with the same entry IDs and costs. The cost of a fork must count only the entries that are not in the parent file, so the workspace total (FR-11) counts each entry once. The tooltip must show the copied cost separately.

## Context view

- **FR-20.** The extension must show a Context view below the session list. When the user selects a session, or chooses "Show Context" on it, the view must show what that session used.
- **FR-21.** The view must list the user prompts, most recent first. If the user clicks a prompt, the extension must open its full text in a read-only editor. A `/skill:<name>` command must be shown as the command, not as the expanded skill text.
- **FR-22.** The view must list the context files (`AGENTS.md`, `CLAUDE.md` and the like) that are recorded in the session's system prompt (`<project_instructions path="…">`). If the session records none, the view must list the context files found on disk now, marked "on disk now".
- **FR-23.** The view must list the skills that the session used, by a `read` of a `SKILL.md` or by a `/skill:<name>` command, and the skills that Pi offered (`<available_skills>` in the system prompt).
- **FR-24.** The view must list the files that tools read, edited or wrote, with a count for each kind. If the user clicks a file, context file or skill, the extension must open it.
- **FR-25.** The view must list the tools called, with call counts, the models used, and compactions with their summaries.
- **FR-26.** Under "On Disk Now", the view must list `SYSTEM.md`, `APPEND_SYSTEM.md`, prompt templates, extensions and MCP config for the session's working directory. These are not recorded in the session, so the view must say they may have changed since it ran.
- **FR-27.** The view must update when the session file changes.

## Pi session storage

Checked against Pi 1.5.2 (`@earendil-works/pi-coding-agent`) and its [session format docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md).

- **Directory.** Pi stores sessions in `~/.pi/agent/sessions/--<encoded-cwd>--/`. To get `<encoded-cwd>`, remove the leading `/` or `\` from the working directory, then replace each `/`, `\`, and `:` with `-`. Example: `/Users/me/patisserie` becomes `--Users-me-patisserie--`.
- **Directory override.** `PI_CODING_AGENT_SESSION_DIR`, the `sessionDir` Pi setting, and the `--session-dir` CLI flag change the directory. `--session-dir` has the highest priority, then the environment variable, then the setting. Pi uses a custom directory as-is, without the `--<encoded-cwd>--` subfolder, so it can hold sessions from many working directories. Pi then keeps only the sessions whose header `cwd` matches. The extension reads the environment variable and the user-level `sessionDir` in `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`). It does not read a project-level `.pi/settings.json`.
- **File name.** `<timestamp>_<session-id>.jsonl`. The timestamp is ISO 8601 with `:` and `.` replaced by `-`. The session ID is a UUID by default.
- **Header.** The first line is `{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}`. `timestamp` is ISO 8601. Use it as the start time (FR-3).
- **Session name.** A `session_info` entry with a `name` field. If there are many, the last one applies. If there is none, show the session ID.
- **Last activity.** The `timestamp` (ISO 8601) of the last entry in the file.
- **Cost.** Assistant messages contain `message.usage.cost.total` (USD). Other entries can contain `usage.cost.total`. If no entry has cost data, the cost is not available (FR-10).
- **Fork.** `pi --fork <id>` writes a new session whose header has `parentSession`: the absolute path of the parent session file.
- **Resume.** `pi --session <path|id>` opens a session by file path or by full or partial ID. `pi --resume` opens an interactive picker, and `pi --continue` resumes the most recent session.
