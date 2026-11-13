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
	/** Total cost in USD, or `undefined` when no entry has cost data (FR-10). */
	readonly cost?: number;
}
