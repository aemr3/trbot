import { validateToolCall, type Static, type Tool, type ToolCall, type TSchema } from "@earendil-works/pi-ai"
import type { ChatBlock } from "@trbot/chat/session.ts"

/**
 * What a tool call produced: what the trader sees, what the model is told, and
 * whether it went wrong.
 *
 * `details` is whatever structured result the tool wants kept beside the blocks;
 * it is stored and never interpreted here.
 */
export interface ChatToolOutcome {
  blocks: ChatBlock[]
  details: unknown
  isError: boolean
}

/**
 * One tool the model may call.
 *
 * Parameters are TypeBox schemas, which the harness re-exports and hands to the
 * provider as JSON Schema unchanged. Declaring them that way is what lets `run`
 * receive typed arguments instead of an untyped bag, and what lets the registry
 * validate a call before it reaches anything that can act.
 */
export interface ChatTool<TParameters extends TSchema = TSchema> {
  definition: Tool<TParameters>
  run(args: Static<TParameters>, options: { signal?: AbortSignal }): Promise<ChatToolOutcome>
}

export interface ChatToolRegistry {
  list(): Tool[]
  call(call: ToolCall, options: { signal?: AbortSignal }): Promise<ChatToolOutcome>
}

/**
 * A registry over a fixed set of tools.
 *
 * Arguments are validated against the tool's own schema before it runs. They are
 * raw model output and the far side of a trbot tool is an API that can move money,
 * so a malformed call has to fail as a tool error the model can read and correct —
 * never as a half-applied action.
 */
export class ChatTools implements ChatToolRegistry {
  private readonly tools = new Map<string, ChatTool>()

  constructor(tools: ChatTool[] = []) {
    for (const tool of tools) this.tools.set(tool.definition.name, tool)
  }

  list(): Tool[] {
    return [...this.tools.values()].map((tool) => tool.definition)
  }

  async call(call: ToolCall, options: { signal?: AbortSignal }): Promise<ChatToolOutcome> {
    const tool = this.tools.get(call.name)
    if (!tool) return toolFailure(`There is no tool named ${call.name}`)
    let args: unknown
    try {
      args = validateToolCall(this.list(), call)
    } catch (error) {
      return toolFailure(error instanceof Error ? error.message : String(error))
    }
    try {
      return await tool.run(args, options)
    } catch (error) {
      return toolFailure(error instanceof Error ? error.message : String(error))
    }
  }
}

/** An empty registry: what the chat runs with until tools are added. */
export function noTools(): ChatToolRegistry {
  return new ChatTools()
}

export function toolText(text: string): ChatBlock {
  return { kind: "TEXT", text, toolName: null, toolCallId: null, toolArguments: null }
}

function toolFailure(message: string): ChatToolOutcome {
  return { blocks: [toolText(message)], details: null, isError: true }
}
