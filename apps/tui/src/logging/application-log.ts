export type LogLevel = "INFO" | "WARN" | "ERROR"

export interface LogEntry {
  id: number
  timestamp: number
  level: LogLevel
  scope: string
  message: string
  details: string | null
}

type LogListener = () => void

const ERROR_DETAIL_KEYS = [
  "statusCode",
  "url",
  "responseBody",
  "isRetryable",
  "data",
] as const

export class ApplicationLog {
  private readonly entries: LogEntry[] = []
  private readonly listeners = new Set<LogListener>()
  private nextId = 1

  constructor(
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  info(scope: string, message: string, details?: unknown): void {
    this.add("INFO", scope, message, details)
  }

  warn(scope: string, message: string, details?: unknown): void {
    this.add("WARN", scope, message, details)
  }

  error(scope: string, error: unknown, message = errorMessage(error)): void {
    this.add("ERROR", scope, message, errorDetails(error))
  }

  list(): LogEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  clear(): void {
    if (this.entries.length === 0) return
    this.entries.length = 0
    this.emit()
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private add(level: LogLevel, scope: string, message: string, details?: unknown): void {
    this.entries.push({
      id: this.nextId++,
      timestamp: this.now(),
      level,
      scope,
      message,
      details: formatDetails(details),
    })
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries)
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function errorDetails(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const record = error as Error & Record<string, unknown>
  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  }
  for (const key of ERROR_DETAIL_KEYS) {
    if (record[key] !== undefined) {
      details[key] = key === "responseBody" && typeof record[key] === "string"
        ? parseJson(record[key])
        : record[key]
    }
  }
  if (error.cause !== undefined) details.cause = errorDetails(error.cause)
  if (error.stack) details.stack = error.stack
  return details
}

function formatDetails(details: unknown): string | null {
  if (details === undefined || details === null) return null
  if (typeof details === "string") return prettyJson(details)
  try {
    return JSON.stringify(details, null, 2)
  } catch {
    return String(details)
  }
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
