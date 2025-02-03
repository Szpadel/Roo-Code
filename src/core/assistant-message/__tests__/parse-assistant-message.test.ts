import { ApiStreamReset, ApiStreamTextChunk } from "../../Conversation"
import { parseAssistantMessage, parseAssistantMessageIncremental } from "../parse-assistant-message"

/**
 * Helper function: Creates an async generator that yields ApiStreamTextChunk
 * objects by splitting the given text into chunks of the specified size.
 */
async function* streamFromString(text: string, chunkSize: number = 1): AsyncGenerator<ApiStreamTextChunk> {
	for (let i = 0; i < text.length; i += chunkSize) {
		yield { type: "text", text: text.slice(i, i + chunkSize) }
	}
}

describe("Parser Comparison Tests", () => {
	// Define a set of test cases with different input scenarios.
	const testCases = [
		{
			description: "Simple text with no tags",
			message: "Hello, world!",
		},
		{
			description: "Text with a tool use (simulate a tool call)",
			message: "Before tool <search>query</search> after tool.",
		},
		{
			description: "Text with a write_to_file tool use and a content param",
			message: "Before file <write_to_file><content>This is file content</content></write_to_file> after file.",
		},
		{
			description: "Text with a write_to_file tool use and a double content param",
			message:
				"Before file <write_to_file><content><content>This is file content</content></content></write_to_file> after file.",
		},
	]

	testCases.forEach(({ description, message }) => {
		test(description, async () => {
			// Get the expected result using the synchronous parser.
			const expected = parseAssistantMessage(message)

			// Test with various chunk sizes to simulate different streaming conditions.
			for (const chunkSize of [1, 3, 10, message.length]) {
				const stream = streamFromString(message, chunkSize)
				const allUpdates: Array<any> = []

				// Run the incremental parser and collect all updates.
				for await (const update of parseAssistantMessageIncremental(stream)) {
					allUpdates.push(update)
				}

				// The final update should be the complete result.
				const finalOutput = allUpdates[allUpdates.length - 1]

				expect(finalOutput).toEqual(expected)
			}
		})
	})
})

describe("Reset Handling Tests", () => {
	test("State is discarded on reset", async () => {
		// In this test, we send some initial text,
		// then a reset event, then new text.
		// Only the text after the reset should be parsed.
		const expected = parseAssistantMessage("World!")
		async function* streamWithReset(): AsyncGenerator<ApiStreamTextChunk | ApiStreamReset> {
			// Initial text that should be discarded.
			yield { type: "text", text: "Hello, " }
			// A reset event: discard any previously accumulated state.
			yield { type: "reset" }
			// New text that should be processed.
			yield { type: "text", text: "World!" }
		}

		const allUpdates: Array<any> = []
		for await (const update of parseAssistantMessageIncremental(streamWithReset())) {
			allUpdates.push(update)
		}
		const finalOutput = allUpdates[allUpdates.length - 1]
		expect(finalOutput).toEqual(expected)
	})
})
