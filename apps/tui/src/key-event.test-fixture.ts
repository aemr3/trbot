import { KeyEvent } from "@opentui/core"

export interface TestKeyOptions {
  sequence?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  option?: boolean
}

/** Creates the complete OpenTUI event its handlers receive from the renderer. */
export function keyEvent(name: string, options: TestKeyOptions = {}): KeyEvent {
  const sequence = options.sequence ?? name
  return new KeyEvent({
    name,
    sequence,
    raw: sequence,
    ctrl: options.ctrl ?? false,
    meta: options.meta ?? false,
    shift: options.shift ?? false,
    option: options.option ?? false,
    number: false,
    eventType: "press",
    source: "raw",
  })
}
