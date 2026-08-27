import { Type } from "@earendil-works/pi-ai"
import type {
  ChatAutomationState,
  ChatGoal,
  ChatLoop,
  CreateChatGoal,
  CreateChatLoop,
} from "@trbot/chat/automation.ts"
import type { ChatToolEffect } from "@trbot/chat/session.ts"
import type { ChatNotification } from "@trbot/chat/notification.ts"
import { reversibleToolEffect, toolText, type ChatTool, type ChatToolRunOptions } from "./tool.ts"

const GetGoalParameters = Type.Object({})
const CreateGoalParameters = Type.Object({
  objective: Type.String({ description: "Concrete objective to pursue", minLength: 1, maxLength: 4_000 }),
  max_turns: Type.Optional(Type.Integer({ description: "Optional continuation-turn limit", minimum: 1, maximum: 500 })),
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
  finishGoal(sessionId: string, status: "COMPLETE" | "BLOCKED", reason: string, expectedGoalId: string | null): Promise<{
    goal: ChatGoal
    notification: ChatNotification | null
  }>
  createLoop(sessionId: string, input: CreateChatLoop): Promise<ChatLoop>
  rescheduleLoop(sessionId: string, loopId: string, intervalMs: number): Promise<ChatLoop>
  cancelLoop(sessionId: string, loopId: string): Promise<void>
}

interface CreateLoopCommonInput {
  prompt?: string
  maxRuns?: number
}

/** Workers may inspect root automation state, but only the root agent may change it. */
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
          "Create or replace the persistent goal for finite work with a verifiable end state.",
          "A goal immediately continues after each settled turn, so every next turn must be able to make concrete progress now.",
          "Never use a goal for waiting, recurring monitoring, work that lasts until a time, or work already driven by a scheduled loop.",
          "This chat cannot run an active goal and active scheduled tasks at the same time.",
          "Only the user-facing root agent can create goals; subagents cannot manage chat automation.",
          "Use only when the user explicitly asks for autonomous goal pursuit.",
          "Set token_budget only when the user explicitly provides a token budget.",
        ].join(" "),
        parameters: CreateGoalParameters,
      },
      run: async ({ objective, max_turns, token_budget }, options) => {
        requireRootAgent(options)
        const sessionId = requireSession(options.chatSessionId)
        const before = (await client.state(sessionId)).goal
        const input: CreateChatGoal = { objective }
        if (max_turns !== undefined) input.maxTurns = max_turns
        if (token_budget !== undefined) input.tokenBudget = token_budget
        const goal = await client.createGoal(sessionId, input)
        return outcome(
          `Created goal ${goal.id}: ${goal.objective}`,
          { goal },
          [reversibleToolEffect(
            "CHAT_GOAL",
            goal.id,
            `${before ? "Replaced" : "Created"} goal: ${goal.objective}`,
            before,
            goal,
          )],
        )
      },
    },
    {
      definition: {
        name: "update_goal",
        description: [
          "Mark this chat's current goal COMPLETE or BLOCKED.",
          "Use COMPLETE only when the objective is achieved with no required work left.",
          "Use BLOCKED only when progress genuinely requires user input or an external change.",
          "Only the user-facing root agent can update goals.",
          "The user controls pause, resume, and clear.",
        ].join(" "),
        parameters: UpdateGoalParameters,
      },
      run: async ({ status, reason }, options) => {
        requireRootAgent(options)
        const sessionId = requireSession(options.chatSessionId)
        const before = (await client.state(sessionId)).goal
        const eventGoalId = options.automationEvent?.label === "goal"
          ? options.automationEvent.referenceId
          : null
        const { goal, notification } = await client.finishGoal(
          sessionId,
          status,
          reason,
          eventGoalId ?? before?.id ?? null,
        )
        return outcome(
          `Goal ${status.toLowerCase()}: ${reason}`,
          { goal },
          [
            reversibleToolEffect(
              "CHAT_GOAL",
              goal.id,
              `Goal was marked ${status.toLowerCase()}`,
              before,
              goal,
            ),
            ...(notification ? [reversibleToolEffect(
              "CHAT_NOTIFICATION",
              notification.id,
              `Notification “${notification.title}” was sent`,
              null,
              notification,
            )] : []),
          ],
        )
      },
    },
    {
      definition: {
        name: "create_loop",
        description: [
          "Schedule a recurring or one-time prompt in this chat.",
          "Use only when the user explicitly asks for scheduled work, recurring monitoring, work that lasts until a time, or a reminder; use market monitors for price or candle conditions.",
          "Use DYNAMIC when current observations should determine the next 1-60 minute delay, and cancel it when its stopping condition is met.",
          "Never use a loop to pace an active goal; this chat cannot run both at the same time.",
          "Only the user-facing root agent can create scheduled tasks; subagents cannot manage chat automation.",
          "INTERVAL needs interval_minutes. DYNAMIC lets the agent choose 1-60 minutes after each run.",
          "CRON needs a five-field local-time cron_expression. ONCE needs an ISO 8601 run_at.",
          "Omit prompt for the configured or built-in maintenance task.",
          "Recurring tasks expire after seven days by default; each chat can hold up to 50 live tasks.",
          "Missed runs are coalesced.",
        ].join(" "),
        parameters: CreateLoopParameters,
      },
      run: async ({ prompt, schedule, interval_minutes, cron_expression, run_at, max_runs }, options) => {
        requireRootAgent(options)
        const sessionId = requireSession(options.chatSessionId)
        const common: CreateLoopCommonInput = {}
        if (prompt !== undefined) common.prompt = prompt
        if (max_runs !== undefined) common.maxRuns = max_runs
        let input: CreateChatLoop
        if (schedule === "INTERVAL") {
          if (interval_minutes === undefined) throw new Error("INTERVAL requires interval_minutes")
          input = { ...common, schedule, intervalMs: interval_minutes * 60_000 }
        } else if (schedule === "DYNAMIC") {
          if (interval_minutes !== undefined && interval_minutes > 60) {
            throw new Error("DYNAMIC interval_minutes must be between 1 and 60")
          }
          input = interval_minutes === undefined
            ? { ...common, schedule }
            : { ...common, schedule, initialDelayMs: interval_minutes * 60_000 }
        } else if (schedule === "CRON") {
          if (!cron_expression) throw new Error("CRON requires cron_expression")
          input = { ...common, schedule, cronExpression: cron_expression }
        } else {
          if (!run_at) throw new Error("ONCE requires run_at")
          const runAt = Date.parse(run_at)
          if (!Number.isFinite(runAt)) throw new Error("run_at must be an ISO 8601 timestamp")
          input = { ...common, schedule, runAt }
        }
        const loop = await client.createLoop(sessionId, input)
        return outcome(
          `Created loop ${loop.id}; next run ${new Date(loop.nextRunAt).toISOString()}.`,
          { loop },
          [reversibleToolEffect(
            "CHAT_LOOP",
            loop.id,
            `Scheduled task ${loop.id} was created`,
            null,
            loop,
          )],
        )
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
        requireRootAgent(options)
        const sessionId = requireSession(options.chatSessionId)
        const before = (await client.state(sessionId)).loops.find((loop) => loop.id === loop_id) ?? null
        await client.cancelLoop(sessionId, loop_id)
        return outcome(
          `Cancelled loop ${loop_id}.`,
          { loopId: loop_id },
          before ? [reversibleToolEffect(
            "CHAT_LOOP",
            loop_id,
            `Scheduled task ${loop_id} was cancelled`,
            before,
            null,
          )] : undefined,
        )
      },
    },
    {
      definition: {
        name: "reschedule_loop",
        description: [
          "Choose the next delay for the DYNAMIC loop that woke the current turn.",
          "Call once after observing the scheduled task's current result; choose 1-60 minutes.",
          "This changes timing only.",
        ].join(" "),
        parameters: RescheduleLoopParameters,
      },
      run: async ({ loop_id, next_interval_minutes }, options) => {
        requireRootAgent(options)
        if (options.automationEvent?.label !== "loop" || options.automationEvent.referenceId !== loop_id) {
          throw new Error("reschedule_loop is only available to the dynamic loop currently running")
        }
        const sessionId = requireSession(options.chatSessionId)
        const before = (await client.state(sessionId)).loops.find((loop) => loop.id === loop_id) ?? null
        const loop = await client.rescheduleLoop(
          sessionId,
          loop_id,
          next_interval_minutes * 60_000,
        )
        return outcome(
          `Next run in ${next_interval_minutes} minutes.`,
          { loop },
          before ? [reversibleToolEffect(
            "CHAT_LOOP",
            loop.id,
            `Scheduled task ${loop.id} was rescheduled`,
            before,
            loop,
          )] : undefined,
        )
      },
    },
  ]
}

function requireRootAgent(options: ChatToolRunOptions): void {
  if ((options.delegation?.depth ?? 0) > 0) {
    throw new Error("Only the user-facing root agent can manage chat goals and scheduled tasks")
  }
}

function requireSession(sessionId: string | undefined): string {
  if (!sessionId) throw new Error("Automation must belong to a chat session")
  return sessionId
}

function goalText(goal: ChatGoal): string {
  const budget = goal.tokenBudget === null ? "no token budget" : `${goal.usedTokens}/${goal.tokenBudget} tokens`
  const turns = goal.maxTurns === null ? `${goal.turnCount} continuation turns` : `${goal.turnCount}/${goal.maxTurns} continuation turns`
  return `${goal.status.toLowerCase()} goal: ${goal.objective}\n${turns}; ${budget}.` +
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

function outcome<T>(text: string, details: T, effects?: ChatToolEffect[]) {
  return { blocks: [toolText(text)], details, isError: false, effects }
}
