import {
  MAX_OUTSTANDING_SUBAGENTS,
  SubagentConcurrency,
  runSubagentTask,
  type SubagentJobDetail,
  type SubagentJobSummary,
  type SubagentJobsClient,
  type SubagentModel,
  type SubagentModels,
  type SubagentSessionRecorder,
} from "@trbot/ai/subagent.ts"
import { createChatDelegationContext, type ChatToolRegistry } from "@trbot/ai/tool.ts"
import {
  type ChatSubagentJob,
  type ChatSubagentJobRecord,
  type ChatSubagentStore,
  type ChatSubagentTask,
  type ChatSubagentViewStatus,
} from "@trbot/chat/subagent.ts"
import type { ChatApplicationEvent } from "@trbot/chat/session.ts"

const RESULT_CAP = 50 * 1_024

export interface ChatSubagentControllerOptions {
  store: ChatSubagentStore
  models: SubagentModels
  tools: ChatToolRegistry
  sessions: SubagentSessionRecorder
  concurrency: SubagentConcurrency
  resolveModel: (providerId: string, modelId: string) => SubagentModel
  requireRootSession: (sessionId: string) => Promise<void>
  pendingPermissionSessionIds: () => Set<string>
  enqueueEvent: (sessionId: string, event: ChatApplicationEvent) => Promise<void>
  onError: (cause: unknown) => void
  now?: () => number
}

/** Runs durable subagent jobs independently from the model turn that created them. */
export class ChatSubagentController implements SubagentJobsClient {
  private readonly runs = new Map<string, AbortController>()
  private readonly now: () => number
  private destroyed = false

  constructor(private readonly options: ChatSubagentControllerOptions) {
    this.now = options.now ?? Date.now
  }

  async prepare(): Promise<void> {
    for (const record of await this.options.store.listRecoverable()) {
      if (isTerminal(record.job.status)) {
        await this.notify(record)
        continue
      }
      const now = this.now()
      for (const task of record.tasks) {
        if (task.status !== "RUNNING") continue
        await this.options.store.putTask({ ...task, status: "QUEUED", updatedAt: now })
      }
      await this.options.store.putJob({ ...record.job, status: "QUEUED", updatedAt: now })
      this.launch(record.job.id)
    }
  }

  async checkCapacity(sessionId: string, requested: number): Promise<boolean> {
    await this.options.requireRootSession(sessionId)
    return await this.options.store.outstanding(sessionId) + requested <= MAX_OUTSTANDING_SUBAGENTS
  }

  async start(input: Parameters<SubagentJobsClient["start"]>[0]): Promise<SubagentJobDetail> {
    await this.options.requireRootSession(input.sessionId)
    const now = this.now()
    const job: ChatSubagentJob = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      parentToolCallId: input.parentToolCallId,
      mode: input.mode,
      status: "QUEUED",
      providerId: input.providerId,
      modelId: input.modelId,
      reasoning: input.reasoning,
      automationLabel: input.automationEvent?.label ?? null,
      automationReferenceId: input.automationEvent?.referenceId ?? null,
      error: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      notifiedAt: null,
    }
    const tasks: ChatSubagentTask[] = input.tasks.map((task, index) => ({
      jobId: job.id,
      index,
      agent: task.agent,
      taskTemplate: task.task,
      resolvedTask: null,
      sessionIds: [],
      status: "QUEUED",
      result: null,
      error: null,
      usage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    }))
    if (!await this.options.store.create(job, tasks, MAX_OUTSTANDING_SUBAGENTS)) {
      throw new Error(`At most ${MAX_OUTSTANDING_SUBAGENTS} queued or running subagents are allowed per root chat`)
    }
    this.launch(job.id)
    return this.view({ job, tasks })
  }

  async list(sessionId: string): Promise<SubagentJobSummary[]> {
    await this.options.requireRootSession(sessionId)
    return (await this.options.store.list(sessionId)).map((record) => this.summary(record))
  }

  async get(sessionId: string, jobId: string): Promise<SubagentJobDetail | null> {
    await this.options.requireRootSession(sessionId)
    const record = await this.options.store.get(jobId)
    return record?.job.sessionId === sessionId ? this.view(record) : null
  }

  async stop(sessionId: string, jobId: string): Promise<SubagentJobDetail | null> {
    await this.options.requireRootSession(sessionId)
    const record = await this.options.store.get(jobId)
    if (!record || record.job.sessionId !== sessionId) return null
    if (isTerminal(record.job.status)) return this.view(record)

    const now = this.now()
    const job = { ...record.job, status: "CANCELLED" as const, error: "Stopped", updatedAt: now, completedAt: now }
    if (!await this.options.store.putJobIfStatus(job, ["QUEUED", "RUNNING"])) {
      const current = await this.options.store.get(jobId)
      return current ? this.view(current) : null
    }
    this.runs.get(jobId)?.abort()
    for (const task of record.tasks) {
      if (isTerminal(task.status)) continue
      await this.options.store.putTaskIfStatus({
        ...task,
        status: "CANCELLED",
        error: "Stopped",
        updatedAt: now,
        completedAt: now,
      }, ["QUEUED", "RUNNING"])
    }
    const stopped = await this.options.store.get(jobId)
    if (stopped) await this.notify(stopped)
    return stopped ? this.view(stopped) : null
  }

  destroy(): void {
    this.destroyed = true
    for (const controller of this.runs.values()) controller.abort()
    this.runs.clear()
  }

  private launch(jobId: string): void {
    if (this.destroyed || this.runs.has(jobId)) return
    const controller = new AbortController()
    this.runs.set(jobId, controller)
    void this.execute(jobId, controller.signal)
      .catch(async (error) => {
        const record = await this.options.store.get(jobId)
        if (this.destroyed || record?.job.status === "CANCELLED") return
        try {
          this.options.onError(error)
          await this.fail(jobId, error)
        } catch (failure) {
          this.options.onError(failure)
        }
      })
      .finally(() => this.runs.delete(jobId))
  }

  private async execute(jobId: string, signal: AbortSignal): Promise<void> {
    const record = await this.options.store.get(jobId)
    if (!record || isTerminal(record.job.status)) return
    const now = this.now()
    if (!await this.options.store.putJobIfStatus(
      { ...record.job, status: "RUNNING", updatedAt: now },
      ["QUEUED"],
    )) return

    const model = this.options.resolveModel(record.job.providerId, record.job.modelId)
    const notificationBudget = { sent: 0 }
    if (record.job.mode === "chain") {
      await this.runChain(record, model, notificationBudget, signal)
    } else {
      await Promise.all(record.tasks.filter((task) => !isTerminal(task.status)).map(async (task) => {
        await this.runTask(record.job, task, task.taskTemplate, model, notificationBudget, signal)
      }))
    }
    if (this.destroyed) return

    const current = await this.options.store.get(jobId)
    if (!current || current.job.status === "CANCELLED") return
    const failed = current.tasks.find((task) => task.status === "FAILED")
    const status = failed ? "FAILED" as const : "COMPLETED" as const
    const completedAt = this.now()
    const job = {
      ...current.job,
      status,
      error: failed?.error ?? null,
      updatedAt: completedAt,
      completedAt,
    }
    if (await this.options.store.putJobIfStatus(job, ["RUNNING"])) {
      await this.notify({ job, tasks: current.tasks })
    }
  }

  private async runChain(
    record: ChatSubagentJobRecord,
    model: SubagentModel,
    notificationBudget: { sent: number },
    signal: AbortSignal,
  ): Promise<void> {
    let previous = ""
    for (const task of record.tasks) {
      if (task.status === "COMPLETED") {
        previous = task.result ?? ""
        continue
      }
      if (isTerminal(task.status)) return
      const resolved = task.taskTemplate.replaceAll("{previous}", previous)
      const result = await this.runTask(record.job, task, resolved, model, notificationBudget, signal)
      if (!result || result.status !== "COMPLETED") {
        await this.cancelQueuedChainTasks(record.job.id, task.index)
        return
      }
      previous = result.result ?? ""
    }
  }

  private async runTask(
    job: ChatSubagentJob,
    task: ChatSubagentTask,
    resolvedTask: string,
    model: SubagentModel,
    notificationBudget: { sent: number },
    signal: AbortSignal,
  ): Promise<ChatSubagentTask | null> {
    return await this.options.concurrency.run(job.sessionId, signal, async () => (
      await this.runTaskWithSlot(job, task, resolvedTask, model, notificationBudget, signal)
    ))
  }

  private async runTaskWithSlot(
    job: ChatSubagentJob,
    task: ChatSubagentTask,
    resolvedTask: string,
    model: SubagentModel,
    notificationBudget: { sent: number },
    signal: AbortSignal,
  ): Promise<ChatSubagentTask | null> {
    if (signal.aborted || this.destroyed) return null
    const startedAt = this.now()
    let current: ChatSubagentTask = { ...task, resolvedTask, status: "RUNNING", updatedAt: startedAt }
    if (!await this.options.store.putTaskIfStatus(current, ["QUEUED"])) return null

    const sessions: SubagentSessionRecorder = {
      start: async (input) => {
        const session = await this.options.sessions.start(input)
        current = await this.appendSession(current, session.sessionId)
        return session
      },
    }
    const result = await runSubagentTask(
      this.options.models,
      this.options.tools,
      task.agent,
      resolvedTask,
      {
        model,
        reasoningEffort: job.reasoning,
        signal,
        chatSessionId: job.sessionId,
        parentToolCallId: job.parentToolCallId ?? undefined,
        notificationBudget,
        automationEvent: job.automationLabel || job.automationReferenceId
          ? { label: job.automationLabel, referenceId: job.automationReferenceId }
          : undefined,
        delegation: { ...createChatDelegationContext(), depth: 1 },
      },
      task.index + 1,
      sessions,
    )
    if (this.destroyed) return null
    const persisted = await this.options.store.get(job.id)
    if (persisted?.job.status === "CANCELLED") return null

    const completedAt = this.now()
    current = {
      ...current,
      status: result.error ? "FAILED" : "COMPLETED",
      result: result.answer,
      error: result.error,
      usage: result.usage,
      updatedAt: completedAt,
      completedAt,
    }
    return await this.options.store.putTaskIfStatus(current, ["RUNNING"])
      ? current
      : (await this.options.store.get(job.id))?.tasks.find((candidate) => candidate.index === task.index) ?? null
  }

  private async appendSession(task: ChatSubagentTask, sessionId: string): Promise<ChatSubagentTask> {
    for (;;) {
      const record = await this.options.store.get(task.jobId)
      const current = record?.tasks.find((candidate) => candidate.index === task.index)
      if (!current) return task
      if (current.sessionIds.includes(sessionId)) return current
      const updated = { ...current, sessionIds: [...current.sessionIds, sessionId], updatedAt: this.now() }
      if (await this.options.store.putTaskIfStatus(updated, [current.status])) return updated
    }
  }

  private async cancelQueuedChainTasks(jobId: string, afterIndex: number): Promise<void> {
    const current = await this.options.store.get(jobId)
    if (!current) return
    const now = this.now()
    for (const task of current.tasks) {
      if (task.index <= afterIndex || task.status !== "QUEUED") continue
      await this.options.store.putTaskIfStatus({
        ...task,
        status: "CANCELLED",
        error: "An earlier chain step failed",
        updatedAt: now,
        completedAt: now,
      }, ["QUEUED"])
    }
  }

  private async fail(jobId: string, cause: unknown): Promise<void> {
    if (this.destroyed) return
    const record = await this.options.store.get(jobId)
    if (!record || isTerminal(record.job.status)) return
    const now = this.now()
    const error = cause instanceof Error ? cause.message : String(cause)
    const job = { ...record.job, status: "FAILED" as const, error, updatedAt: now, completedAt: now }
    if (!await this.options.store.putJobIfStatus(job, ["QUEUED", "RUNNING"])) return
    for (const task of record.tasks) {
      if (isTerminal(task.status)) continue
      await this.options.store.putTaskIfStatus({
        ...task,
        status: task.status === "RUNNING" ? "FAILED" : "CANCELLED",
        error: task.status === "RUNNING" ? error : "The background job failed before this task started",
        updatedAt: now,
        completedAt: now,
      }, [task.status])
    }
    const failed = await this.options.store.get(jobId)
    if (failed) await this.notify(failed)
  }

  private async notify(record: ChatSubagentJobRecord): Promise<void> {
    const view = this.view(record)
    const successes = record.tasks.filter((task) => task.status === "COMPLETED").length
    const summaries = record.tasks.map((task) => {
      const output = bounded((task.error ?? task.result) || "(no output)")
      return `### Step ${task.index + 1} [${task.agent}] ${task.status}\n\n${output}`
    })
    await this.options.enqueueEvent(record.job.sessionId, {
      key: `subagent:${record.job.id}:${record.job.status}`,
      text: `Background subagent job ${record.job.id} ${record.job.status.toLowerCase()} (${successes}/${record.tasks.length} succeeded).`,
      prompt: [
        `Background subagent job ${record.job.id} has finished with status ${view.status}.`,
        "Use these results to continue the user's task. Do not rerun completed work.",
        ...summaries,
      ].join("\n\n"),
      label: "subagent",
      referenceId: record.job.id,
    })
    await this.options.store.putJobIfStatus({ ...record.job, notifiedAt: this.now() }, [record.job.status])
  }

  private summary(record: ChatSubagentJobRecord): SubagentJobSummary {
    return {
      jobId: record.job.id,
      mode: record.job.mode,
      status: this.status(record),
      completed: record.tasks.filter((task) => isTerminal(task.status)).length,
      total: record.tasks.length,
      createdAt: record.job.createdAt,
      updatedAt: record.job.updatedAt,
    }
  }

  private view(record: ChatSubagentJobRecord): SubagentJobDetail {
    const pending = this.options.pendingPermissionSessionIds()
    return {
      ...this.summary(record),
      error: record.job.error,
      tasks: record.tasks.map((task) => ({
        index: task.index,
        agent: task.agent,
        task: task.resolvedTask ?? task.taskTemplate,
        status: task.status === "RUNNING" && task.sessionIds.some((id) => pending.has(id))
          ? "WAITING_PERMISSION"
          : task.status,
        sessionIds: task.sessionIds,
        result: task.result === null ? null : bounded(task.result),
        error: task.error,
        usage: task.usage,
      })),
    }
  }

  private status(record: ChatSubagentJobRecord): ChatSubagentViewStatus {
    if (record.job.status !== "RUNNING") return record.job.status
    const pending = this.options.pendingPermissionSessionIds()
    return record.tasks.some((task) => task.sessionIds.some((id) => pending.has(id)))
      ? "WAITING_PERMISSION"
      : "RUNNING"
  }
}

function isTerminal(status: ChatSubagentJob["status"]): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED"
}

function bounded(value: string): string {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= RESULT_CAP) return value
  return `${new TextDecoder().decode(encoded.slice(0, RESULT_CAP))}\n\n[Output truncated; full transcript is preserved.]`
}
