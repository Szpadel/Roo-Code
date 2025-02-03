import { Anthropic } from "@anthropic-ai/sdk"
import cloneDeep from "clone-deep"
import { DiffStrategy, getDiffStrategy, UnifiedDiffStrategy } from "./diff/DiffStrategy"
import { validateToolUse, isToolAllowedForMode, ToolName } from "./mode-validator"
import delay from "delay"
import fs from "fs/promises"
import os from "os"
import pWaitFor from "p-wait-for"
import * as path from "path"
import { serializeError } from "serialize-error"
import * as vscode from "vscode"
import { ApiHandler, SingleCompletionHandler, buildApiHandler } from "../api"
import { ApiStream } from "../api/transform/stream"
import { DiffViewProvider } from "../integrations/editor/DiffViewProvider"
import { findToolName, formatContentBlockToMarkdown } from "../integrations/misc/export-markdown"
import {
	extractTextFromFile,
	addLineNumbers,
	stripLineNumbers,
	everyLineHasLineNumbers,
	truncateOutput,
} from "../integrations/misc/extract-text"
import { TerminalManager } from "../integrations/terminal/TerminalManager"
import { UrlContentFetcher } from "../services/browser/UrlContentFetcher"
import { listFiles } from "../services/glob/list-files"
import { regexSearchFiles } from "../services/ripgrep"
import { parseSourceCodeForDefinitionsTopLevel } from "../services/tree-sitter"
import { ApiConfiguration } from "../shared/api"
import { findLastIndex } from "../shared/array"
import { combineApiRequests } from "../shared/combineApiRequests"
import { combineCommandSequences } from "../shared/combineCommandSequences"
import {
	BrowserAction,
	BrowserActionResult,
	browserActions,
	ClineApiReqCancelReason,
	ClineApiReqInfo,
	ClineAsk,
	ClineAskUseMcpServer,
	ClineMessage,
	ClineSay,
	ClineSayBrowserAction,
	ClineSayTool,
} from "../shared/ExtensionMessage"
import { getApiMetrics } from "../shared/getApiMetrics"
import { HistoryItem } from "../shared/HistoryItem"
import { ClineAskResponse } from "../shared/WebviewMessage"
import { calculateApiCost } from "../utils/cost"
import { fileExistsAtPath } from "../utils/fs"
import { arePathsEqual, getReadablePath } from "../utils/path"
import { parseMentions } from "./mentions"
import { AssistantMessageContent, parseAssistantMessage, ToolParamName, ToolUseName } from "./assistant-message"
import { formatResponse } from "./prompts/responses"
import { SYSTEM_PROMPT } from "./prompts/system"
import { modes, defaultModeSlug, getModeBySlug } from "../shared/modes"
import { truncateHalfConversation } from "./sliding-window"
import { ClineProvider, GlobalFileNames } from "./webview/ClineProvider"
import { detectCodeOmission } from "../integrations/editor/detect-omission"
import { BrowserSession } from "../services/browser/BrowserSession"
import { OpenRouterHandler } from "../api/providers/openrouter"
import { McpHub } from "../services/mcp/McpHub"
import crypto from "crypto"
import { insertGroups } from "./diff/insert-groups"
import { EXPERIMENT_IDS, experiments as Experiments } from "../shared/experiments"
import { EventChannel, EventSubscription } from "./EventChannel"
import { Task } from "./Task"

const cwd =
	vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath).at(0) ?? path.join(os.homedir(), "Desktop") // may or may not exist but fs checking existence would immediately ask for permission which would be bad UX, need to come up with a better solution

type ToolResponse = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>
type UserContent = Array<
	Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam
>

/**
 * Container class allowing to replace ApiHandler at runtime without need to propagate
 * the change through the whole codebase.
 */
export class ApiImplementation {
	private events = new EventChannel<ApiHandler>()
	constructor(private apiInner: ApiHandler) {}

	set api(api: ApiHandler) {
		this.apiInner = api
		this.events.publish(api)
	}

	get api() {
		return this.apiInner
	}

	/**
	 * Subscribe for notification when the api handler changes
	 */
	public subscribe(): EventSubscription<ApiHandler> {
		return this.events.subscribe()
	}
}

export class Cline {
	private apiImpl: ApiImplementation
	private currentTask?: Task

	// Temporary for compatibility with old Cline
	public taskId = ""

	constructor(
		private provider: ClineProvider,
		private apiConfiguration: ApiConfiguration,
		private customInstructionsImpl?: string,
		private enableDiff?: boolean,
		private fuzzyMatchThreshold?: number,
		private task?: string | undefined,
		private images?: string[] | undefined,
		private historyItem?: HistoryItem | undefined,
		private experiments?: Record<string, boolean>,
	) {
		this.apiImpl = new ApiImplementation(buildApiHandler(apiConfiguration))
		setTimeout(async () => {
			this.currentTask = Task.fromString(this.apiImpl, await this.systemPrompt(), task ?? "")
			const events = this.currentTask.subscribe()
			setTimeout(async () => {
				await this.provider.postStateToWebview()
				for await (const event of events) {
					await this.provider.postStateToWebview()
				}
			}, 0)
			await this.loop()
		}, 0)
	}

	private async loop() {
		let task = this.currentTask
		if (!task) {
			return
		}

		let context = task.conversation.generateContext()
		let cancel = new Promise(() => {})
		let stream = task.conversation.requestParsedAssistantMessage(context, cancel)
		for await (const msg of stream) {
			console.log(msg)
		}
	}

	public updateCustomInstructions(customInstructions: string | undefined) {
		this.customInstructionsImpl = customInstructions
	}

	public setApiHandler(apiHandler: ApiHandler) {
		this.apiImpl.api = apiHandler
	}

	private async systemPrompt() {
		const {
			browserViewportSize,
			mode,
			customModePrompts,
			preferredLanguage,
			experiments,
			enableMcpServerCreation,
		} = (await this.provider.getState()) ?? {}
		const { customModes } = (await this.provider.getState()) ?? {}
		return SYSTEM_PROMPT(
			this.provider.context,
			cwd,
			false, // this.api.getModel().info.supportsComputerUse ?? false,
			undefined, // mcpHub,
			undefined, // this.diffStrategy,
			browserViewportSize,
			mode,
			customModePrompts,
			customModes,
			this.customInstructionsImpl,
			preferredLanguage,
			false, // this.diffEnabled,
			experiments,
			enableMcpServerCreation,
		)
	}

	public getMessages(): ClineMessage[] {
		return this.currentTask?.conversation.getClineMessages() ?? []
	}

	public getApiMessages(): (Anthropic.MessageParam & { ts?: number })[] {
		return this.currentTask?.conversation.generateContext() ?? []
	}

	public updateDiffStrategy(experimentalDiffStrategy?: boolean) {
		// TODO: implement
	}

	public overwriteClineMessages(newMessages: ClineMessage[]) {}
	public overwriteApiConversationHistory(newHistory: Anthropic.MessageParam[]) {}

	// Compatibility with old Cline
	get clineMessages(): ClineMessage[] {
		return this.getMessages()
	}

	handleWebviewAskResponse(a: any, b: any, c: any) {
		debugger
	}

	abortTask() {}

	set abandoned(value: boolean) {}

	get didFinishAborting() {
		return true
	}

	get apiConversationHistory() {
		return this.getApiMessages()
	}

	set api(api: ApiHandler) {
		this.setApiHandler(api)
	}

	set customInstructions(value: string | undefined) {
		this.updateCustomInstructions(value)
	}
}
