import { Type } from "@earendil-works/pi-ai"
import type {
  ChatAutomationState,
  ChatGoal,
  ChatLoop,
  CreateChatGoal,
  CreateChatLoop,
} from "@trbot/chat/automation.ts"
import { toolText, type ChatTool } from "./tool.ts"

const GetGoalParameters = Type.Object({})
const CreateGoalParameters = Type.Object({
  objective: Type.String({ description: "Concrete objective to pursue", minLength: 1, maxLength: 4_000 }),
  max_turns: Type.Optional(Type.Integer({ description: "Safety cap for autonomous continuation turns", minimum: 1, maximum: 500 })),
  token_budget: Type.Optional(Type.Integer({ description: "Optional positive token budget for this goal", minimum: 1 })),
})
const UpdateGoalParameters = Type.Object({
  status: Type.Union([Type.Literal("COMPLETE"), Type.Literal("BLOCKED")]),
  reason: Type.String({ description: "Evidence that the goal is complete or genuinely blocked", minLength: 1, maxLength: 1_000 }),
})
const CreateLoopParameters = Type.Object({
  prompt: Type.Optional(Type.String({
    description: "Task to run. Omit to use the user's configured maintenance prompt.",
    minLength: 1,
    maxLength: 4_000,
  })),
  schedule: Type.Union([
    Type.Literal("INTERVAL"),
    Type.Literal("DYNAMIC"),
    Type.Literal("CRON"),
    Type.Literal("ONCE"),
  ], { description: "Fixed interval, agent-chosen delay, five-field local cron, or one-time run" }),
  interval_minutes: Type.Optional(Type.Integer({
    description: "Required for INTERVAL; optional initial 1-60 minute delay for DYNAMIC",
    minimum: 1,
  })),
  cron_expression: Type.Optional(Type.String({ description: "Required five-field cron for CRON", minLength: 1 })),
  run_at: Type.Optional(Type.String({ description: "Required ISO 8601 timestamp for ONCE", minLength: 1 })),
  max_runs: Type.Optional(Type.Integer({ description: "Optional number of runs before completing", minimum: 1 })),
})
const ListLoopsParameters = Type.Object({})
const CancelLoopParameters = Type.Object({
  loop_id: Type.String({ description: "Loop id returned by create_loop or list_loops", minLength: 1 }),
})
const RescheduleLoopParameters = Type.Object({
  loop_id: Type.String({ description: "Dynamic loop id from the current scheduled event", minLength: 1 }),
  next_interval_minutes: Type.Integer({
    description: "Delay before the next run, chosen from current observations",
    minimum: 1,
    maximum: 60,
  }),
})

export interface ChatAutomationToolsClient {
  state(sessionId: string): Promise<ChatAutomationState>
  createGoal(sessionId: string, input: CreateChatGoal): Promise<ChatGoal>
  finishGoal(sessionId: string, status: "COMPLETE" | "BLOCKED", reason: string): Promise<ChatGoal>
  createLoop(sessionId: string, input: CreateChatLoop): Promise<ChatLoop>
  rescheduleLoop(sessionId: string, loopId: string, intervalMs: number): Promise<ChatLoop>
  cancelLoop(sessionId: string, loopId: string): Promise<void>
}

/** Goal and schedule tools share the originating root chat, including when called by a subagent. */
export function automationTools(client: ChatAutomationToolsClient): ChatTool[] {
  return [
    {
      definition: {
        name: "get_goal",
        description: "Read this chat's current goal, status, limits, usage, and latest evaluator reason.",
        parameters: GetGoalParameters,
      },
      run: async (_args, options) => {
        const state = await client.state(requireSession(options.chatSessionId))
        return outcome(state.goal ? goalText(state.goal) : "This chat has no goal.", { goal: state.goal })
      },
    },
    {
      definition: {
        name: "create_goal",
        description: [
          "Create or replace the persistent goal for this chat so work can continue across settled turns.",
          "Use only when the user explicitly asks for autonomous goal pursuit.",
          "Set token_budget only when the user explicitly provides a token budget.",
          "This creates ANALYSIS_ONLY work and does not grant order authorization.",
        ].join(" "),
        parameters: CreateGoalParameters,
      },
      run: async ({ objective, max_turns, token_budget }, options) => {
        const goal = await client.createGoal(requireSession(options.chatSessionId), {
          objective,
          ...(max_turns === undefined ? {} : { maxTurns: max_turns }),
          ...(token_budget === undefined ? {} : { tokenBudget: token_budget }),
        })
        return outcome(`Created goal ${goal.id}: ${goal.objective}`, { goal })
      },
    },
    {
      definition: {
        name: "update_goal",
        description: [
          "Mark this chat's current goal COMPLETE or BLOCKED.",
          "Use COMPLETE only when the objective is achieved with no required work left.",
          "Use BLOCKED only when progress genuinely requires user input or an external change.",
          "The user controls pause, resume, clear, and execution authorization.",
        ].join(" "),
        parameters: UpdateGoalParameters,
      },
      run: async ({ status, reason }, options) => {
        const goal = await client.finishGoal(requireSession(options.chatSessionId), status, reason)
        return outcome(`Goal ${status.toLowerCase()}: ${reason}`, { goal })
      },
    },
    {
      definition: {
        name: "create_loop",
        description: [
          "Schedule a recurring or one-time prompt in this chat.",
          "Use only when the user explicitly asks for scheduled work or a reminder; use market monitors for price or candle conditions.",
          "INTERVAL needs interval_minutes. DYNAMIC lets the agent choose 1-60 minutes after each run.",
          "CRON needs a five-field local-time cron_expression. ONCE needs an ISO 8601 run_at.",
          "Omit prompt for the configured or built-in maintenance task.",
          "Recurring tasks expire after seven days by default; each chat can hold up to 50 live tasks.",
          "Missed runs are coalesced, and this creates ANALYSIS_ONLY work without order authorization.",
        ].join(" "),
        parameters: CreateLoopParameters,
      },
      run: async ({ prompt, schedule, interval_minutes, cron_expression, run_at, max_runs }, options) => {
        const common = {
          ...(prompt === undefined ? {} : { prompt }),
          ...(max_runs === undefined ? {} : { maxRuns: max_runs }),
        }
        let input: CreateChatLoop
        if (schedule === "INTERVAL") {
          if (interval_minutes === undefined) throw new Error("INTERVAL requires interval_minutes")
          input = { ...common, schedule, intervalMs: interval_minutes * 60_000 }
        } else if (schedule === "DYNAMIC") {
          if (interval_minutes !== undefined && interval_minutes > 60) {
            throw new Error("DYNAMIC interval_minutes must be between 1 and 60")
          }
          input = {
            ...common,
            schedule,
            ...(interval_minutes === undefined ? {} : { initialDelayMs: interval_minutes * 60_000 }),
          }
        } else if (schedule === "CRON") {
          if (!cron_expression) throw new Error("CRON requires cron_expression")
          input = { ...common, schedule, cronExpression: cron_expression }
        } else {
          if (!run_at) throw new Error("ONCE requires run_at")
          const runAt = Date.parse(run_at)
          if (!Number.isFinite(runAt)) throw new Error("run_at must be an ISO 8601 timestamp")
          input = { ...common, schedule, runAt }
        }
        const loop = await client.createLoop(requireSession(options.chatSessionId), input)
        return outcome(`Created loop ${loop.id}; next run ${new Date(loop.nextRunAt).toISOString()}.`, { loop })
      },
    },
    {
      definition: {
        name: "list_loops",
        description: "List the recurring scheduled prompts owned by this chat.",
        parameters: ListLoopsParameters,
      },
      run: async (_args, options) => {
        const loops = (await client.state(requireSession(options.chatSessionId))).loops
        const text = loops.length === 0
          ? "This chat has no loops."
          : loops.map((loop) => (
              `${loop.id}: ${loop.status.toLowerCase()} ${scheduleText(loop)}; next ${new Date(loop.nextRunAt).toISOString()} — ${loop.prompt}`
            )).join("\n")
        return outcome(text, { loops })
      },
    },
    {
      definition: {
        name: "cancel_loop",
        description: "Cancel and remove one recurring scheduled prompt from this chat.",
        parameters: CancelLoopParameters,
      },
      run: async ({ loop_id }, options) => {
        await client.cancelLoop(requireSession(options.chatSessionId), loop_id)
        return outcome(`Cancelled loop ${loop_id}.`, { loopId: loop_id })
      },
    },
    {
      definition: {
        name: "reschedule_loop",
        description: [
          "Choose the next delay for the DYNAMIC loop that woke the current turn.",
          "Call once after observing the scheduled task's current result; choose 1-60 minutes.",
          "This changes timing only and never changes execution authorization.",
        ].join(" "),
        parameters: RescheduleLoopParameters,
      },
      run: async ({ loop_id, next_interval_minutes }, options) => {
        if (options.automationEvent?.label !== "loop" || options.automationEvent.referenceId !== loop_id) {
          throw new Error("reschedule_loop is only available to the dynamic loop currently running")
        }
        const loop = await client.rescheduleLoop(
          requireSession(options.chatSessionId),
          loop_id,
          next_interval_minutes * 60_000,
        )
        return outcome(`Next run in ${next_interval_minutes} minutes.`, { loop })
      },
    },
  ]
}

function requireSession(sessionId: string | undefined): string {
  if (!sessionId) throw new Error("Automation must belong to a chat session")
  return sessionId
}

function goalText(goal: ChatGoal): string {
  const budget = goal.tokenBudget === null ? "no token budget" : `${goal.usedTokens}/${goal.tokenBudget} tokens`
  return `${goal.status.toLowerCase()} goal: ${goal.objective}\n${goal.turnCount}/${goal.maxTurns} continuation turns; ${budget}.` +
    (goal.lastEvaluation ? `\nEvaluator: ${goal.lastEvaluation}` : "")
}

function formatInterval(intervalMs: number): string {
  if (intervalMs % 86_400_000 === 0) return `${intervalMs / 86_400_000}d`
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`
  return `${intervalMs / 60_000}m`
}

function scheduleText(loop: ChatLoop): string {
  if (loop.schedule === "CRON") return `cron ${loop.cronExpression}`
  if (loop.schedule === "ONCE") return `once at ${new Date(loop.nextRunAt).toISOString()}`
  if (loop.schedule === "DYNAMIC") return `dynamic (currently ${formatInterval(loop.intervalMs ?? 60_000)})`
  return `every ${formatInterval(loop.intervalMs ?? 60_000)}`
}

function outcome(text: string, details: unknown) {
  return { blocks: [toolText(text)], details, isError: false }
}
