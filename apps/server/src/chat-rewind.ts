import {
  ChatGoalSchema,
  ChatLoopSchema,
  type ChatAutomationState,
  type ChatGoal,
  type ChatLoop,
} from "@trbot/chat/automation.ts"
import { ChatNotificationSchema, type ChatNotification } from "@trbot/chat/notification.ts"
import type { ChatToolEffect, ChatUndoEffect } from "@trbot/chat/session.ts"
import { MarketMonitorSchema, type MarketMonitor } from "@trbot/market/market-monitor.ts"
import { StopRuleSchema, type StopRule } from "@trbot/trading/stop.ts"

interface RewindMarketMonitors {
  get(id: string): MarketMonitor | null
  restore(id: string, monitor: MarketMonitor | null): Promise<void>
}

interface RewindStops {
  get(id: string): StopRule | null
  restore(id: string, rule: StopRule | null): Promise<void>
}

interface RewindAutomations {
  state(sessionId: string): Promise<ChatAutomationState>
  restoreGoal(sessionId: string, goal: ChatGoal | null): Promise<void>
  restoreLoop(sessionId: string, loopId: string, loop: ChatLoop | null): Promise<void>
}

interface RewindNotifications {
  list(): ChatNotification[]
  restore(id: string, notification: ChatNotification | null): Promise<void>
}

export interface ChatRewindEffectsOptions {
  marketMonitors: RewindMarketMonitors
  stops: RewindStops
  automations: RewindAutomations
  notifications: RewindNotifications
}

export interface ChatEffectRevertResult {
  reverted: string[]
  preserved: string[]
}

type EffectState = "APPLICABLE" | "ALREADY_REVERTED" | "PRESERVED"
type RewindSnapshot = MarketMonitor | StopRule | ChatGoal | ChatLoop | ChatNotification | null

/** Safely inspects and restores application-owned mutations recorded by chat tools. */
export class ChatRewindEffects {
  constructor(private readonly options: ChatRewindEffectsOptions) {}

  async preview(effects: ChatToolEffect[]): Promise<ChatUndoEffect[]> {
    const preview = Array<ChatUndoEffect>(effects.length)
    const virtual = new Map<string, RewindSnapshot>()
    for (let index = effects.length - 1; index >= 0; index--) {
      const effect = effects[index]!
      let state: EffectState = "PRESERVED"
      if (effect.reversible && effect.resourceId) {
        const snapshots = this.snapshots(effect)
        if (snapshots) {
          const key = `${effect.kind}:${effect.resourceId}`
          const current = virtual.has(key)
            ? virtual.get(key) ?? null
            : await this.current(effect, snapshots.after).catch(() => undefined)
          if (current !== undefined) {
            if (sameState(current, snapshots.after)) state = "APPLICABLE"
            else if (sameState(current, snapshots.before)) state = "ALREADY_REVERTED"
            if (state !== "PRESERVED") virtual.set(key, snapshots.before)
          }
        }
      }
      preview[index] = {
        description: state === "PRESERVED" && effect.reversible
          ? `${effect.description} (state changed since then)`
          : effect.description,
        reversible: state !== "PRESERVED",
      }
    }
    return preview
  }

  async revert(sessionId: string, effects: ChatToolEffect[]): Promise<ChatEffectRevertResult> {
    const reverted: string[] = []
    const preserved: string[] = []
    for (const effect of [...effects].reverse()) {
      const state = await this.state(effect).catch(() => "PRESERVED" as const)
      if (state === "PRESERVED") {
        preserved.unshift(effect.description)
        continue
      }
      if (state === "APPLICABLE") {
        try {
          await this.restore(sessionId, effect)
        } catch {
          preserved.unshift(`${effect.description} (restore failed)`)
          continue
        }
      }
      reverted.unshift(effect.description)
    }
    return { reverted, preserved }
  }

  private async state(effect: ChatToolEffect): Promise<EffectState> {
    if (!effect.reversible || !effect.resourceId) return "PRESERVED"
    const snapshots = this.snapshots(effect)
    if (!snapshots) return "PRESERVED"
    const current = await this.current(effect, snapshots.after)
    if (sameState(current, snapshots.after)) return "APPLICABLE"
    if (sameState(current, snapshots.before)) return "ALREADY_REVERTED"
    return "PRESERVED"
  }

  private snapshots(effect: ChatToolEffect): { before: RewindSnapshot; after: RewindSnapshot } | null {
    if (effect.kind === "MARKET_MONITOR") {
      const before = MarketMonitorSchema.nullable().safeParse(effect.before)
      const after = MarketMonitorSchema.nullable().safeParse(effect.after)
      return before.success && after.success ? { before: before.data, after: after.data } : null
    }
    if (effect.kind === "STOP_RULE") {
      const before = StopRuleSchema.nullable().safeParse(effect.before)
      const after = StopRuleSchema.nullable().safeParse(effect.after)
      return before.success && after.success ? { before: before.data, after: after.data } : null
    }
    if (effect.kind === "CHAT_GOAL") {
      const before = ChatGoalSchema.nullable().safeParse(effect.before)
      const after = ChatGoalSchema.nullable().safeParse(effect.after)
      return before.success && after.success ? { before: before.data, after: after.data } : null
    }
    if (effect.kind === "CHAT_LOOP") {
      const before = ChatLoopSchema.nullable().safeParse(effect.before)
      const after = ChatLoopSchema.nullable().safeParse(effect.after)
      return before.success && after.success ? { before: before.data, after: after.data } : null
    }
    if (effect.kind === "CHAT_NOTIFICATION") {
      const before = ChatNotificationSchema.nullable().safeParse(effect.before)
      const after = ChatNotificationSchema.nullable().safeParse(effect.after)
      return before.success && after.success ? { before: before.data, after: after.data } : null
    }
    return null
  }

  private async current(effect: ChatToolEffect, after: RewindSnapshot): Promise<RewindSnapshot> {
    const id = effect.resourceId!
    if (effect.kind === "MARKET_MONITOR") {
      return MarketMonitorSchema.nullable().parse(this.options.marketMonitors.get(id))
    }
    if (effect.kind === "STOP_RULE") {
      return StopRuleSchema.nullable().parse(this.options.stops.get(id))
    }
    if (effect.kind === "CHAT_GOAL") {
      const snapshot = ChatGoalSchema.nullable().parse(after ?? effect.before)
      return ChatGoalSchema.nullable().parse(
        snapshot ? (await this.options.automations.state(snapshot.sessionId)).goal : null,
      )
    }
    if (effect.kind === "CHAT_LOOP") {
      const snapshot = ChatLoopSchema.nullable().parse(after ?? effect.before)
      return ChatLoopSchema.nullable().parse(snapshot
        ? (await this.options.automations.state(snapshot.sessionId)).loops.find((entry) => entry.id === id) ?? null
        : null)
    }
    if (effect.kind === "CHAT_NOTIFICATION") {
      return ChatNotificationSchema.nullable().parse(
        this.options.notifications.list().find((entry) => entry.id === id) ?? null,
      )
    }
    return null
  }

  private async restore(sessionId: string, effect: ChatToolEffect): Promise<void> {
    const id = effect.resourceId!
    if (effect.kind === "MARKET_MONITOR") {
      await this.options.marketMonitors.restore(id, MarketMonitorSchema.nullable().parse(effect.before))
      return
    }
    if (effect.kind === "STOP_RULE") {
      await this.options.stops.restore(id, StopRuleSchema.nullable().parse(effect.before))
      return
    }
    if (effect.kind === "CHAT_GOAL") {
      await this.options.automations.restoreGoal(sessionId, ChatGoalSchema.nullable().parse(effect.before))
      return
    }
    if (effect.kind === "CHAT_LOOP") {
      await this.options.automations.restoreLoop(sessionId, id, ChatLoopSchema.nullable().parse(effect.before))
      return
    }
    if (effect.kind === "CHAT_NOTIFICATION") {
      await this.options.notifications.restore(id, ChatNotificationSchema.nullable().parse(effect.before))
    }
  }
}

function sameState(left: RewindSnapshot, right: RewindSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
