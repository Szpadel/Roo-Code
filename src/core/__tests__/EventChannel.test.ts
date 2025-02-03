import { EventChannel } from "../EventChannel"

describe("EventChannel", () => {
	test("single subscription receives a published event", async () => {
		const channel = new EventChannel<number>()
		const subscription = channel.subscribe()
		channel.publish(1)
		const result = await subscription.next()
		expect(result.value).toBe(1)
	})

	test("subscription queues multiple events", async () => {
		const channel = new EventChannel<string>()
		const subscription = channel.subscribe()
		channel.publish("first")
		channel.publish("second")
		const firstResult = await subscription.next()
		const secondResult = await subscription.next()
		expect(firstResult.value).toBe("first")
		expect(secondResult.value).toBe("second")
	})

	test("multiple subscriptions receive published event", async () => {
		const channel = new EventChannel<number>()
		const sub1 = channel.subscribe()
		const sub2 = channel.subscribe()
		channel.publish(42)
		const result1 = await sub1.next()
		const result2 = await sub2.next()
		expect(result1.value).toBe(42)
		expect(result2.value).toBe(42)
	})

	test("subscription receives events published before awaiting", async () => {
		const channel = new EventChannel<number>()
		const subscription = channel.subscribe()
		// Publish events before awaiting next
		channel.publish(10)
		channel.publish(20)
		// Now await multiple next calls
		const result1 = await subscription.next()
		const result2 = await subscription.next()
		expect(result1.value).toBe(10)
		expect(result2.value).toBe(20)
	})

	test("Test await for next event", async () => {
		const channel = new EventChannel<number>()
		const subscription = channel.subscribe()
		const results = []
		channel.publish(10)
		channel.publish(20)
		for await (const result of subscription) {
			results.push(result)
			if (results.length === 2) {
				break
			}
		}
		expect(results).toEqual([10, 20])
	})

	test("subscriptions are garbage collected when out of scope", async () => {
		if (typeof global.gc !== "function") {
			console.warn("Skipping garbage collection test. Run Node with --expose-gc flag.")
			return
		}
		const channel = new EventChannel<number>()

		await new Promise((resolve) =>
			setTimeout(async () => {
				// Create a subscription in a limited scope
				const sub = channel.subscribe()
				channel.publish(1)
				expect((await sub.next()).value).toBe(1)
				resolve(null)
			}, 0),
		)

		await new Promise((resolve) => setTimeout(resolve, 0))
		global.gc({
			execution: "sync",
			type: "major",
		})
		for (const sub of channel.subscriptions) {
			expect(sub.deref()).toBe(undefined)
		}

		// Trigger cleanup of dead subscriptions
		channel.publish(2)

		// Verify that all subscriptions have been cleaned up
		expect(channel.subscriptions.size).toBe(0)
	})
})
