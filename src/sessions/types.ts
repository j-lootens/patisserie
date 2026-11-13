/** A Pi session read from a session file. See docs/requirements.md, "Pi session storage". */
export interface PiSession {
	/** Session ID from the header line. */
	readonly id: string;
	/** Name from the last `session_info` entry, if any. */
	readonly name?: string;
	/** Absolute path to the `.jsonl` session file. */
	readonly filePath: string;
	/** Header `timestamp`. */
	readonly startTime: Date;
	/** `timestamp` of the last entry in the file. */
	readonly lastActivity: Date;
	/**
	 * Cost in USD of the entries this session added, or `undefined` when none has
	 * cost data (FR-10). For a fork, entries copied from the parent are not
	 * counted, so the workspace total counts them once (FR-35).
	 */
	readonly cost?: number;
	/** For a fork: cost of the entries copied from the parent session. */
	readonly inheritedCost?: number;
	/** File path of the session this one was forked from (header `parentSession`), if any. */
	readonly parentSession?: string;
	/**
	 * True when the last message leaves the turn to the agent: a user message,
	 * a tool result, or an assistant message that stopped to call tools.
	 */
	readonly agentTurn?: boolean;
}

/** Live state of a session (FR-30). */
export type SessionStatus = 'working' | 'waiting' | 'inactive';
