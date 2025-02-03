import {
	AssistantMessageContent,
	TextContent,
	ToolUse,
	ToolParamName,
	toolParamNames,
	toolUseNames,
	ToolUseName,
} from "."
import { ApiStreamReset, ApiStreamTextChunk } from "../Conversation"

/**
 * An incremental parser that consumes an async stream of ApiStreamTextChunk
 * and yields an updated array of AssistantMessageContent each time the state changes.
 *
 * Note: This is temporary implementation that need to be optimized
 */
export async function* parseAssistantMessageIncremental(
	stream: AsyncGenerator<ApiStreamTextChunk | ApiStreamReset>,
): AsyncGenerator<AssistantMessageContent[]> {
	let contentBlocks: AssistantMessageContent[] = []
	let currentTextContent: TextContent | undefined = undefined
	let currentTextContentStartIndex = 0
	let currentToolUse: ToolUse | undefined = undefined
	let currentToolUseStartIndex = 0
	let currentParamName: ToolParamName | undefined = undefined
	let currentParamValueStartIndex = 0
	let accumulator = ""

	// Helper to build a snapshot of the current content blocks.
	const emit = (): AssistantMessageContent[] => {
		const blocks = [...contentBlocks]
		if (currentToolUse) blocks.push(currentToolUse)
		if (currentTextContent) blocks.push(currentTextContent)
		return blocks
	}

	for await (const event of stream) {
		// If we receive a reset event, clear all state.
		if (event.type === "reset") {
			accumulator = ""
			contentBlocks = []
			currentTextContent = undefined
			currentToolUse = undefined
			currentParamName = undefined
			yield []
			continue
		}

		// Process text chunks as before.
		// event is an ApiStreamTextChunk here.
		for (let j = 0; j < event.text.length; j++) {
			const char = event.text[j]
			accumulator += char

			// --- CASE 1: If inside a tool parameter ---
			if (currentToolUse && currentParamName) {
				const currentParamValue = accumulator.slice(currentParamValueStartIndex)
				const paramClosingTag = `</${currentParamName}>`
				if (currentParamValue.endsWith(paramClosingTag)) {
					// End of parameter value.
					currentToolUse.params[currentParamName] = currentParamValue.slice(0, -paramClosingTag.length).trim()
					currentParamName = undefined
					yield emit()
					continue
				} else {
					yield emit()
					continue
				}
			}

			// --- CASE 2: If inside a tool use block (but not in a param) ---
			if (currentToolUse) {
				const currentToolValue = accumulator.slice(currentToolUseStartIndex)
				const toolUseClosingTag = `</${currentToolUse.name}>`
				if (currentToolValue.endsWith(toolUseClosingTag)) {
					// End of tool use.
					currentToolUse.partial = false
					contentBlocks.push(currentToolUse)
					currentToolUse = undefined
					yield emit()
					continue
				} else {
					// Look for a parameter start.
					const possibleParamOpeningTags = toolParamNames.map((name) => `<${name}>`)
					let foundParam = false
					for (const paramOpeningTag of possibleParamOpeningTags) {
						if (accumulator.endsWith(paramOpeningTag)) {
							// Start of a new parameter.
							currentParamName = paramOpeningTag.slice(1, -1) as ToolParamName
							currentParamValueStartIndex = accumulator.length
							foundParam = true
							yield emit()
							break
						}
					}
					if (foundParam) continue

					// Special case: For write_to_file, the file contents may contain the closing tag.
					const contentParamName: ToolParamName = "content"
					if (currentToolUse.name === "write_to_file" && accumulator.endsWith(`</${contentParamName}>`)) {
						const toolContent = accumulator.slice(currentToolUseStartIndex)
						const contentStartTag = `<${contentParamName}>`
						const contentEndTag = `</${contentParamName}>`
						const contentStartIndex = toolContent.indexOf(contentStartTag) + contentStartTag.length
						const contentEndIndex = toolContent.lastIndexOf(contentEndTag)
						if (contentStartIndex !== -1 && contentEndIndex !== -1 && contentEndIndex > contentStartIndex) {
							currentToolUse.params[contentParamName] = toolContent
								.slice(contentStartIndex, contentEndIndex)
								.trim()
							yield emit()
						}
					}
					yield emit()
					continue
				}
			}

			// --- CASE 3: Free text (not in a tool use) ---
			let didStartToolUse = false
			const possibleToolUseOpeningTags = toolUseNames.map((name) => `<${name}>`)
			for (const toolUseOpeningTag of possibleToolUseOpeningTags) {
				if (accumulator.endsWith(toolUseOpeningTag)) {
					// Start of a new tool use.
					currentToolUse = {
						type: "tool_use",
						name: toolUseOpeningTag.slice(1, -1) as ToolUseName,
						params: {},
						partial: true,
					}
					currentToolUseStartIndex = accumulator.length
					// End the current text block.
					if (currentTextContent) {
						currentTextContent.partial = false
						// Remove the partially accumulated tool use tag from the text.
						const removeLength = toolUseOpeningTag.slice(0, -1).length
						currentTextContent.content = currentTextContent.content.slice(0, -removeLength).trim()
						contentBlocks.push(currentTextContent)
						currentTextContent = undefined
					}
					didStartToolUse = true
					yield emit()
					break
				}
			}
			if (!didStartToolUse) {
				// Accumulate free text.
				if (!currentTextContent) {
					currentTextContentStartIndex = accumulator.length - 1
				}
				currentTextContent = {
					type: "text",
					content: accumulator.slice(currentTextContentStartIndex).trim(),
					partial: true,
				}
				yield emit()
			}
		} // End processing for the current text chunk.
	} // End for-await loop over the stream

	// Finalize any still-open (partial) blocks.
	if (currentToolUse) {
		if (currentParamName) {
			currentToolUse.params[currentParamName] = accumulator.slice(currentParamValueStartIndex).trim()
		}
		contentBlocks.push(currentToolUse)
	}
	if (currentTextContent) {
		contentBlocks.push(currentTextContent)
	}
	yield contentBlocks
}

export function parseAssistantMessage(assistantMessage: string) {
	let contentBlocks: AssistantMessageContent[] = []
	let currentTextContent: TextContent | undefined = undefined
	let currentTextContentStartIndex = 0
	let currentToolUse: ToolUse | undefined = undefined
	let currentToolUseStartIndex = 0
	let currentParamName: ToolParamName | undefined = undefined
	let currentParamValueStartIndex = 0
	let accumulator = ""

	for (let i = 0; i < assistantMessage.length; i++) {
		const char = assistantMessage[i]
		accumulator += char

		// there should not be a param without a tool use
		if (currentToolUse && currentParamName) {
			const currentParamValue = accumulator.slice(currentParamValueStartIndex)
			const paramClosingTag = `</${currentParamName}>`
			if (currentParamValue.endsWith(paramClosingTag)) {
				// end of param value
				currentToolUse.params[currentParamName] = currentParamValue.slice(0, -paramClosingTag.length).trim()
				currentParamName = undefined
				continue
			} else {
				// partial param value is accumulating
				continue
			}
		}

		// no currentParamName

		if (currentToolUse) {
			const currentToolValue = accumulator.slice(currentToolUseStartIndex)
			const toolUseClosingTag = `</${currentToolUse.name}>`
			if (currentToolValue.endsWith(toolUseClosingTag)) {
				// end of a tool use
				currentToolUse.partial = false
				contentBlocks.push(currentToolUse)
				currentToolUse = undefined
				continue
			} else {
				const possibleParamOpeningTags = toolParamNames.map((name) => `<${name}>`)
				for (const paramOpeningTag of possibleParamOpeningTags) {
					if (accumulator.endsWith(paramOpeningTag)) {
						// start of a new parameter
						currentParamName = paramOpeningTag.slice(1, -1) as ToolParamName
						currentParamValueStartIndex = accumulator.length
						break
					}
				}

				// there's no current param, and not starting a new param

				// special case for write_to_file where file contents could contain the closing tag, in which case the param would have closed and we end up with the rest of the file contents here. To work around this, we get the string between the starting content tag and the LAST content tag.
				const contentParamName: ToolParamName = "content"
				if (currentToolUse.name === "write_to_file" && accumulator.endsWith(`</${contentParamName}>`)) {
					const toolContent = accumulator.slice(currentToolUseStartIndex)
					const contentStartTag = `<${contentParamName}>`
					const contentEndTag = `</${contentParamName}>`
					const contentStartIndex = toolContent.indexOf(contentStartTag) + contentStartTag.length
					const contentEndIndex = toolContent.lastIndexOf(contentEndTag)
					if (contentStartIndex !== -1 && contentEndIndex !== -1 && contentEndIndex > contentStartIndex) {
						currentToolUse.params[contentParamName] = toolContent
							.slice(contentStartIndex, contentEndIndex)
							.trim()
					}
				}

				// partial tool value is accumulating
				continue
			}
		}

		// no currentToolUse

		let didStartToolUse = false
		const possibleToolUseOpeningTags = toolUseNames.map((name) => `<${name}>`)
		for (const toolUseOpeningTag of possibleToolUseOpeningTags) {
			if (accumulator.endsWith(toolUseOpeningTag)) {
				// start of a new tool use
				currentToolUse = {
					type: "tool_use",
					name: toolUseOpeningTag.slice(1, -1) as ToolUseName,
					params: {},
					partial: true,
				}
				currentToolUseStartIndex = accumulator.length
				// this also indicates the end of the current text content
				if (currentTextContent) {
					currentTextContent.partial = false
					// remove the partially accumulated tool use tag from the end of text (<tool)
					currentTextContent.content = currentTextContent.content
						.slice(0, -toolUseOpeningTag.slice(0, -1).length)
						.trim()
					contentBlocks.push(currentTextContent)
					currentTextContent = undefined
				}

				didStartToolUse = true
				break
			}
		}

		if (!didStartToolUse) {
			// no tool use, so it must be text either at the beginning or between tools
			if (currentTextContent === undefined) {
				currentTextContentStartIndex = i
			}
			currentTextContent = {
				type: "text",
				content: accumulator.slice(currentTextContentStartIndex).trim(),
				partial: true,
			}
		}
	}

	if (currentToolUse) {
		// stream did not complete tool call, add it as partial
		if (currentParamName) {
			// tool call has a parameter that was not completed
			currentToolUse.params[currentParamName] = accumulator.slice(currentParamValueStartIndex).trim()
		}
		contentBlocks.push(currentToolUse)
	}

	// Note: it doesnt matter if check for currentToolUse or currentTextContent, only one of them will be defined since only one can be partial at a time
	if (currentTextContent) {
		// stream did not complete text content, add it as partial
		contentBlocks.push(currentTextContent)
	}

	return contentBlocks
}
