import {
  validateToolCall,
  type Api,
  type Model,
  type Static,
  type Tool,
  type ToolCall,
  type TSchema,
} from "@earendil-works/pi-ai"
import type { ChatBlock, ChatToolEffect, ChatUsage } from "@trbot/chat/session.ts"

/** What a tool call produced for the trader, the model, and application rewind. */
export interface ChatToolOutcome {
  /** A compact account of the call for the transcript. */
  blocks: ChatBlock[]
  /** Full content for the model when the transcript should stay compact. */
  modelBlocks?: ChatBlock[]
  /** Optional tool-specific metadata retained for future application consumers. */
  details?: unknown
  isError: boolean
  /** Successful state changes journaled for optional conversation rewind. */
  effects?: ChatToolEffect[]
  /** Model usage incurred inside the tool, such as delegated agent work. */
  usage?: ChatUsage
}

export interface ChatDelegationContext {
  /** Current worker depth. The user-facing chat starts at zero. */
  depth: number
  /** Shared across every worker created during one user-facing turn. */
  budget: { created: number }
}

export function createChatDelegationContext(): ChatDelegationContext {
  return { depth: 0, budget: { created: 0 } }
}

export interface ChatToolRunOptions {
  signal?: AbortSignal
  /** Present when a tool is called by ChatAgent; optional for direct registry use in tests. */
  model?: Model<Api>
  reasoningEffort?: string | null
  /** Originating conversation, inherited by delegated workers. */
  chatSessionId?: string
  /** Provider tool-call ID for associating durable child work with its parent transcript. */
  toolCallId?: string
  /** Shared worker depth and budget for delegation during this turn. */
  delegation?: ChatDelegationContext
  /** Shared by the parent and every worker so one turn cannot spam notices. */
  notificationBudget?: { sent: number }
  /** Application event that woke the root turn, inherited by its workers. */
  automationEvent?: { label: string | null; referenceId: string | null }
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

type JsonLiteral = string | number | boolean | null

interface ToolValidationSchema {
  properties?: Record<string, ToolValidationSchema>
  anyOf?: ToolValidationSchema[]
  oneOf?: ToolValidationSchema[]
  enum?: JsonLiteral[]
  const?: JsonLiteral
}

interface ToolValidationIssue {
  path: string
  message: string
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
      const message = error instanceof Error ? error.message : String(error)
      return toolFailure(formatToolValidationFailure(tool.definition, call, message))
    }
    try {
      return await tool.run(args, { ...options, toolCallId: call.id })
    } catch (error) {
      return toolFailure(error instanceof Error ? error.message : String(error))
    }
  }
}

/** Turn noisy union-branch failures into one actionable message per argument. */
function formatToolValidationFailure(tool: Tool, call: ToolCall, message: string): string {
  if (!message.startsWith(`Validation failed for tool "${call.name}":`)) return message

  const issues = parseToolValidationIssues(message)
  if (issues.length === 0) return message

  // SAFETY: Tool parameters are internal TypeBox schemas, whose union/object fields
  // use the JSON Schema shapes read below.
  const schema = tool.parameters as ToolValidationSchema
  const paths = [...new Set(issues.map((issue) => issue.path))]
  const lines = paths.map((path) => {
    const accepted = acceptedValues(schemaAtPath(schema, path))
    if (accepted.length > 0) {
      return `  - ${path}: expected one of ${accepted.join(", ")}`
    }
    const descriptions = [...new Set(
      issues.filter((issue) => issue.path === path).map((issue) => issue.message),
    )]
    return `  - ${path}: ${descriptions.join("; ")}`
  })

  return [
    `Invalid arguments for tool "${call.name}":`,
    ...lines,
    `Received arguments: ${JSON.stringify(call.arguments)}`,
  ].join("\n")
}

function parseToolValidationIssues(message: string): ToolValidationIssue[] {
  return message.split("\n").flatMap((line) => {
    const match = /^\s*-\s+([^:]+):\s*(.+)$/.exec(line)
    const path = match?.[1]?.trim()
    const issue = match?.[2]?.trim()
    return path && issue ? [{ path, message: issue }] : []
  })
}

function schemaAtPath(schema: ToolValidationSchema, path: string): ToolValidationSchema | undefined {
  if (path === "root") return schema
  let current: ToolValidationSchema | undefined = schema
  for (const part of path.split(".")) current = current?.properties?.[part]
  return current
}

function acceptedValues(schema: ToolValidationSchema | undefined): JsonLiteral[] {
  if (!schema) return []
  if (schema.enum) return schema.enum
  const branches = schema.anyOf ?? schema.oneOf ?? []
  return branches.flatMap((branch) => {
    if (branch.enum) return branch.enum
    return branch.const === undefined ? [] : [branch.const]
  })
}

/** An empty registry: what the chat runs with until tools are added. */
export function noTools(): ChatToolRegistry {
  return new ChatTools()
}

export function toolText(text: string): ChatBlock {
  return { kind: "TEXT", text, toolName: null, toolCallId: null, toolArguments: null }
}

export function reversibleToolEffect(
  kind: Exclude<ChatToolEffect["kind"], "EXTERNAL">,
  resourceId: string,
  description: string,
  before: unknown | null,
  after: unknown | null,
): ChatToolEffect {
  return { kind, resourceId, description, reversible: true, before, after }
}

export function externalToolEffect(description: string): ChatToolEffect {
  return {
    kind: "EXTERNAL",
    resourceId: null,
    description,
    reversible: false,
    before: null,
    after: null,
  }
}

function toolFailure(message: string): ChatToolOutcome {
  return { blocks: [toolText(message)], isError: true }
}
