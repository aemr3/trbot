import {
  validateToolCall,
  type Api,
  type Model,
  type Static,
  type Tool,
  type ToolCall,
  type TSchema,
} from "@earendil-works/pi-ai"
import type { ChatBlock, ChatUsage } from "@trbot/chat/session.ts"

/**
 * What a tool call produced: what the trader sees, what the model is told, and
 * whether it went wrong.
 *
 * `details` is whatever structured result the tool wants kept beside the blocks;
 * it is stored and never interpreted here.
 */
export interface ChatToolOutcome {
  /** A compact account of the call for the transcript. */
  blocks: ChatBlock[]
  /** Full content for the model when the transcript should stay compact. */
  modelBlocks?: ChatBlock[]
  details: unknown
  isError: boolean
  /** Model usage incurred inside the tool, such as delegated agent work. */
  usage?: ChatUsage
}

export interface ChatToolRunOptions {
  signal?: AbortSignal
  /** Present when a tool is called by ChatAgent; optional for direct registry use in tests. */
  model?: Model<Api>
  reasoningEffort?: string | null
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
  run(args: Static<TParameters>, options: ChatToolRunOptions): Promise<ChatToolOutcome>
}

export interface ChatToolRegistry {
  list(): Tool[]
  call(call: ToolCall, options: ChatToolRunOptions): Promise<ChatToolOutcome>
}

/**
 * A registry of tools available to an agent.
 *
 * Arguments are validated against the tool's own schema before it runs. They are
 * raw model output and the far side of a trbot tool is an API that can move money,
 * so a malformed call has to fail as a tool error the model can read and correct —
 * never as a half-applied action.
 */
export class ChatTools implements ChatToolRegistry {
  private readonly tools = new Map<string, ChatTool>()

  constructor(tools: ChatTool[] = []) {
    for (const tool of tools) this.register(tool)
  }

  /** Add a tool after construction, allowing a tool to receive its complete registry. */
  register(tool: ChatTool): void {
    this.tools.set(tool.definition.name, tool)
  }

  list(): Tool[] {
    return [...this.tools.values()].map((tool) => tool.definition)
  }

  async call(call: ToolCall, options: ChatToolRunOptions): Promise<ChatToolOutcome> {
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
