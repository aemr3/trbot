import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { keyEvent } from "../key-event.test-fixture.ts"
import { LevelEditorFrame } from "./level-editor-frame.ts"

type Field = "kind" | "value" | "action"

test("routes editor navigation, choices, numeric edits, submission, and close", async () => {
  const harness = await createTestRenderer({ width: 80, height: 24 })
  const cycles: Array<[Field, number]> = []
  let value = ""
  let moves = 0
  let saves = 0
  let closes = 0
  const frame = new LevelEditorFrame<Field>(harness.renderer, {
    fields: () => ["kind", "value", "action"],
    initialField: "value",
    valueField: "value",
    actionField: "action",
    borderColor: "white",
    onClose: () => closes++,
    onFieldChange: () => moves++,
    onCycle: (field, direction) => cycles.push([field, direction]),
    onEdit: (field, edit) => {
      if (field === "value") value = edit(value)
    },
    onSave: () => saves++,
  })
  harness.renderer.root.add(frame.root)

  try {
    frame.handleKey(keyEvent("up"))
    frame.handleKey(keyEvent("right"))
    expect(frame.field).toBe("kind")
    expect(cycles).toEqual([["kind", 1]])

    frame.handleKey(keyEvent("tab"))
    frame.handleKey(keyEvent("1"))
    frame.handleKey(keyEvent(".", { sequence: "." }))
    frame.handleKey(keyEvent("5"))
    frame.handleKey(keyEvent("backspace"))
    expect(frame.field).toBe("value")
    expect(value).toBe("1.")

    frame.handleKey(keyEvent("return"))
    frame.handleKey(keyEvent("return"))
    frame.handleKey(keyEvent("escape"))
    expect(frame.field).toBe("action")
    expect(moves).toBe(3)
    expect(saves).toBe(1)
    expect(closes).toBe(1)
  } finally {
    frame.destroy()
    harness.renderer.destroy()
  }
})
