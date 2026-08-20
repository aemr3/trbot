import type { ChatNotifier } from "@trbot/ai/notification.ts"
import type { ChatNotification, ChatNotificationStore } from "@trbot/chat/notification.ts"
import { ProtocolError } from "@trbot/protocol/error.ts"
import type { ChatFrame } from "@trbot/protocol/stream.ts"

export interface ChatNotificationControllerOptions {
  store: ChatNotificationStore
  broadcast: (frame: ChatFrame) => void
  now?: () => number
}

/** Owns pending agent notices and their durable delivery lifecycle. */
export class ChatNotificationController implements ChatNotifier {
  private readonly pending = new Map<string, ChatNotification>()
  private readonly now: () => number

  constructor(private readonly options: ChatNotificationControllerOptions) {
    this.now = options.now ?? Date.now
  }

  async load(): Promise<void> {
    this.pending.clear()
    for (const notification of await this.options.store.list()) {
      this.pending.set(notification.id, notification)
    }
  }

  /** Reconciles database cascades, such as deleting a chat with pending notices. */
  async sync(): Promise<void> {
    const previous = new Set(this.pending.keys())
    await this.load()
    for (const id of previous) {
      if (!this.pending.has(id)) {
        this.options.broadcast({ type: "chatNotificationDismissed", notificationId: id })
      }
    }
  }

  list(): ChatNotification[] {
    return [...this.pending.values()]
  }

  async notify(input: Parameters<ChatNotifier["notify"]>[0]): Promise<ChatNotification> {
    const notification: ChatNotification = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: this.now(),
    }
    await this.options.store.put(notification)
    this.pending.set(notification.id, notification)
    this.options.broadcast({ type: "chatNotification", notification })
    return notification
  }

  async dismiss(id: string): Promise<void> {
    if (!this.pending.has(id)) throw new ProtocolError("not_found", "No such pending notification")
    await this.options.store.remove(id)
    this.pending.delete(id)
    this.options.broadcast({ type: "chatNotificationDismissed", notificationId: id })
  }

  backlog(): ChatFrame[] {
    return this.list().map((notification) => ({ type: "chatNotification", notification }))
  }
}
