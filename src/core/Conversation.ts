import Anthropic from "@anthropic-ai/sdk"
import { ClineMessage, ClineSay } from "../shared/ExtensionMessage"
import { EventChannel, EventSubscription } from "./EventChannel"
import { ApiHandler } from "../api"
import { ApiStreamChunk, ApiStreamReasoningChunk, ApiStreamTextChunk } from "../api/transform/stream"
import { cancelableStream, filterStream } from "./stream-utils"
import { AssistantMessageContent } from "./assistant-message"
import { parseAssistantMessageIncremental } from "./assistant-message/parse-assistant-message"
import { ClineProvider } from "./webview/ClineProvider"
import { SYSTEM_PROMPT } from "./prompts/system"
import * as vscode from "vscode"
import * as path from "path"
import os from "os"
import { ApiImplementation } from "./ClineModular"

export interface NewMessage {
	type: "newMessage"
	message: ClineMessage
}

export interface MessageUpdated {
	type: "messageUpdated"
	message: ClineMessage
}

export interface MessageRemoved {
	type: "messageRemoved"
	message: ClineMessage
}

export type ConversationEvents = NewMessage | MessageUpdated | MessageRemoved

/**
 * Emitted when previous message data should be discarded
 * This happens when new api call is started (before any messages are received)
 * or when some error happened and we are retrying the call
 */
export interface ApiStreamReset {
	type: "reset"
}

export type { ApiStreamTextChunk, ApiStreamReasoningChunk }
export type MsgStream = ApiStreamTextChunk | ApiStreamReasoningChunk | ApiStreamReset
export class Conversation {
	private messages: ClineMessage[] = []
	private files: string[] = []
	private events = new EventChannel<ConversationEvents>()
	private api: ApiImplementation
	private systemPrompt: string

	constructor(api: ApiImplementation, systemPrompt: string) {
		this.api = api
		this.systemPrompt = systemPrompt
	}

	public getClineMessages(): ClineMessage[] {
		return this.messages
	}

	/**
	 * Subscribe to conversation events
	 */
	public subscribe(): EventSubscription<ConversationEvents> {
		return this.events.subscribe()
	}

	public addMessage(message: ClineMessage) {
		this.messages.push(message)
	}

	public addAssistantMessage(text: string, images?: string[]) {
		this.newMessage({ ts: Date.now(), type: "say", say: "text", text, images })
	}

	public addUserMessage(text: string, images?: string[]) {
		this.newMessage({ ts: Date.now(), type: "ask", ask: "followup", text, images })
	}

	protected newMessage(message: ClineMessage) {
		this.addMessage(message)
		this.events.publish({ type: "newMessage", message })
	}

	public generateContext(): (Anthropic.MessageParam & { ts?: number })[] {
		// TODO: Convert to Anthropic.Message[]
		// TODO: strip old messages if they cannot fit in context
		return this.messages
			.filter((msg) => msg.type === "ask" || msg.type === "say")
			.map((msg): Anthropic.MessageParam & { ts?: number } => ({
				ts: msg.ts,
				role: msg.type === "ask" ? "user" : "assistant",
				content: [{ type: "text", text: msg.text || "" }],
			}))
	}

	async *requestLLMInner(context: Anthropic.MessageParam[], cancel: Promise<any>): AsyncGenerator<MsgStream> {
		// TODO: rate limit
		// TODO: retry
		// TODO: mcp
		let stream = this.api.api.createMessage(this.systemPrompt, context)
		stream = cancelableStream(
			stream,
			cancel.then((): ApiStreamChunk => ({ type: "usage", inputTokens: 0, outputTokens: 0 })),
		)

		// Track new messages added by this iteration to allow easy rollback in case of error
		let newMessages = []

		try {
			let newMessage: ClineMessage | undefined
			for await (const chunk of stream) {
				let msgType: ClineSay | undefined
				if (chunk.type === "reasoning") {
					msgType = "reasoning"
				} else if (chunk.type === "text") {
					msgType = "text"
				}

				if (msgType) {
					let msgChunk = chunk as ApiStreamTextChunk | ApiStreamReasoningChunk
					if (newMessage && newMessage.say === msgType) {
						newMessage.text += msgChunk.text
						this.events.publish({ type: "messageUpdated", message: newMessage })
					} else {
						newMessage = { ts: Date.now(), type: "say", say: msgType, text: msgChunk.text }
						this.newMessage(newMessage)
						newMessages.push(newMessage)
					}
					yield msgChunk
				} else if (chunk.type === "usage") {
					// TODO: usage tracking
				}
			}
		} catch (error) {
			// Rollback new messages
			for (const message of newMessages) {
				this.messages.pop()
				this.events.publish({ type: "messageRemoved", message })
			}

			// TODO: error handling/retrying
		}
	}

	async *requestParsedAssistantMessage(
		context: Anthropic.MessageParam[],
		cancel: Promise<any>,
	): AsyncGenerator<AssistantMessageContent[]> {
		const responseStream = this.requestLLMInner(context, cancel)
		const textOrResetStream: AsyncGenerator<ApiStreamTextChunk | ApiStreamReset> = filterStream(
			responseStream,
			(chunk): chunk is ApiStreamTextChunk | ApiStreamReset => chunk.type !== "reasoning",
		)
		yield* parseAssistantMessageIncremental(textOrResetStream)
	}

	public async parseMentions(): Promise<void> {
		throw new Error("TODO: Not implemented")
	}
}
