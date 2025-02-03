import { Task } from "./Task"
import { ClineProvider } from "./webview/ClineProvider"
import * as path from "path"

export class HistorySerializer {
	private provider: ClineProvider

	constructor(provider: ClineProvider) {
		this.provider = provider
	}

	get globalStoragePath(): string {
		return this.provider.context.globalStorageUri.fsPath
	}

	/**
	 * Load a task from the history
	 */
	public async loadTaskFromHistory(): Promise<Task> {
		throw new Error("TODO: Not implemented")
	}

	/**
	 * Serialize a task to the history file
	 * @param task
	 */
	public async saveTaskToHistory(task: Task): Promise<void> {
		throw new Error("TODO: Not implemented")
	}
}
