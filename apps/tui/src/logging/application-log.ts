import { z } from "zod"

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

const JsonValueSchema = z.json()
const JsonValueInputSchema = z.preprocess((value) => value, JsonValueSchema)
type JsonValue = z.output<typeof JsonValueSchema>
const JsonObjectSchema = z.record(z.string(), JsonValueSchema)
type JsonObject = z.output<typeof JsonObjectSchema>
const ErrorExtensionsSchema = z.object({
  statusCode: JsonValueSchema.optional(),
  url: JsonValueSchema.optional(),
  responseBody: JsonValueSchema.optional(),
  isRetryable: JsonValueSchema.optional(),
  data: JsonValueSchema.optional(),
})

export class ApplicationLog {
  private readonly entries: LogEntry[] = []
  private readonly listeners = new Set<LogListener>()
  private nextId = 1

  constructor(
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  info(scope: string, message: string, details?: z.input<typeof JsonValueInputSchema>): void {
    this.add("INFO", scope, message, details)
  }

  warn(scope: string, message: string, details?: z.input<typeof JsonValueInputSchema>): void {
    this.add("WARN", scope, message, details)
  }

  error(scope: string, cause: unknown, message = errorMessage(cause)): void {
    this.add("ERROR", scope, message, errorDetails(cause))
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

  private add(level: LogLevel, scope: string, message: string, details?: z.input<typeof JsonValueInputSchema>): void {
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

function errorDetails(cause: unknown): JsonValue {
  if (!(cause instanceof Error)) return jsonValue(cause)
  const details: JsonObject = {
    name: cause.name,
    message: cause.message,
  }
  const parsedExtensions = ErrorExtensionsSchema.safeParse(cause)
  const extensions = parsedExtensions.success ? parsedExtensions.data : {}
  for (const key of ERROR_DETAIL_KEYS) {
    const value = extensions[key]
    if (value !== undefined) {
      details[key] = key === "responseBody" && z.string().safeParse(value).success
        ? parseJson(String(value))
        : value
    }
  }
  if (cause.cause !== undefined) details.cause = errorDetails(cause.cause)
  if (cause.stack) details.stack = cause.stack
  return details
}

function formatDetails(details: z.input<typeof JsonValueInputSchema>): string | null {
  if (details === undefined || details === null) return null
  const text = z.string().safeParse(details)
  if (text.success) return prettyJson(text.data)
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

function parseJson(value: string): JsonValue {
  try {
    return jsonValue(JSON.parse(value))
  } catch {
    return value
  }
}

function jsonValue(value: z.input<typeof JsonValueInputSchema>): JsonValue {
  const parsed = JsonValueSchema.safeParse(value)
  return parsed.success ? parsed.data : String(value)
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
