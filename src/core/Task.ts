import { ApiImplementation } from "./ClineModular"
import { Conversation, ConversationEvents } from "./Conversation"
import { EventChannel, EventSubscription } from "./EventChannel"

export interface ConversationEvent {
	type: "conversationEvent"
	event: ConversationEvents
}

export type TaskEvent = ConversationEvent

/**
 * For now Task is 1:1 with Conversation, but in the future it might have more
 * conversations per task
 */
export class Task {
	/** Unique identifier for the task */
	private id: string = crypto.randomUUID()
	private taskName: string = ""
	public readonly conversation: Conversation
	private events = new EventChannel<TaskEvent>()
	/**
	 * Do not create this class directly, use the factory methods instead
	 */
	private constructor(api: ApiImplementation, systemPrompt: string) {
		this.conversation = new Conversation(api, systemPrompt)
		let sub = this.conversation.subscribe()
		// Forward conversation events to task events
		setTimeout(async () => {
			for await (const event of sub) {
				this.events.publish({ type: "conversationEvent", event })
			}
		}, 0)
	}

	public subscribe(): EventSubscription<TaskEvent> {
		return this.events.subscribe()
	}

	/**
	 * Create new task from a string
	 */
	public static fromString(api: ApiImplementation, systemPrompt: string, text: string): Task {
		const task = new Task(api, systemPrompt)
		task.taskName = text
		task.conversation.addUserMessage(text)
		return task
	}

	/**
	 * Create new task from a string and an image
	 */
	public static fromStringAndImage(
		api: ApiImplementation,
		systemPrompt: string,
		text: string,
		images: string[],
	): Task {
		const task = new Task(api, systemPrompt)
		task.taskName = text
		task.conversation.addUserMessage(text, images)
		return task
	}
}
