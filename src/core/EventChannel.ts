export type EventSubscription<Event> = AsyncGenerator<Event, void, void>

class Subscription<Event> {
	private queue: Event[] = []
	private notify: ((value: unknown) => void) | undefined

	public push(event: Event) {
		this.queue.push(event)
		if (this.notify) {
			this.notify(undefined)
		}
	}

	public async *subscribe(): EventSubscription<Event> {
		while (true) {
			let event: Event | undefined
			// Emit all events in queue
			while ((event = this.queue.shift())) {
				yield event
			}
			// Wait for next event
			await new Promise((resolve) => {
				this.notify = resolve
			})
		}
	}
}

export class EventChannel<Event> {
	public subscriptions: Set<WeakRef<Subscription<Event>>> = new Set()

	/**
	 * Subscribe to events
	 * Usage example:
	 * ```typescript
	 * const subscription = channel.subscribe()
	 * for await (const event of subscription) {
	 *  console.log(event)
	 * }
	 * ```
	 *
	 * Or using next method:
	 * ```typescript
	 * const subscription = channel.subscribe()
	 * const result = await subscription.next()
	 * console.log(result.value)
	 * ```
	 */
	public subscribe(): EventSubscription<Event> {
		const subscription = new Subscription<Event>()
		this.subscriptions.add(new WeakRef(subscription))
		return subscription.subscribe()
	}

	/**
	 * Publish an event to all subscribers
	 */
	public publish(event: Event) {
		for (const ref of this.subscriptions) {
			const subscription = ref.deref()
			if (subscription) {
				subscription.push(event)
			} else {
				// subscription was garbage collected
				this.subscriptions.delete(ref)
			}
		}
	}
}
