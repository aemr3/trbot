import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { KeyEvent } from "@opentui/core"
import { SelectableList } from "./selectable-list.ts"

function key(name: string): KeyEvent {
  return { name } as KeyEvent
}

test("navigates rows with wrap-around, home/end, and reports selection", async () => {
  const { renderer } = await createTestRenderer({ width: 40, height: 10 })
  const selected: number[] = []
  const list = new SelectableList(renderer, { onSelect: (index) => selected.push(index) })
  list.setRows([
    { id: "a", content: "a" },
    { id: "b", content: "b" },
    { id: "c", content: "c" },
  ])

  expect(list.selectedIndex).toBe(0)

  list.handleKey(key("down"))
  expect(list.selectedIndex).toBe(1)

  list.handleKey(key("up"))
  list.handleKey(key("up")) // wrap past the top
  expect(list.selectedIndex).toBe(2)

  list.handleKey(key("home"))
  expect(list.selectedIndex).toBe(0)

  list.handleKey(key("end"))
  expect(list.selectedIndex).toBe(2)

  expect(selected).toEqual([1, 0, 2, 0, 2])
  expect(list.handleKey(key("space"))).toBe(false)

  list.destroy()
  renderer.destroy()
})

test("activates the selected row on Enter", async () => {
  const { renderer } = await createTestRenderer({ width: 40, height: 10 })
  const activated: number[] = []
  const list = new SelectableList(renderer, { onActivate: (index) => activated.push(index) })
  list.setRows([
    { id: "a", content: "a" },
    { id: "b", content: "b" },
  ])

  list.handleKey(key("down"))
  expect(list.handleKey(key("return"))).toBe(true)
  expect(activated).toEqual([1])

  list.destroy()
  renderer.destroy()
})

test("preserves a selected row by id when rows are reordered", async () => {
  const { renderer } = await createTestRenderer({ width: 40, height: 10 })
  const selected: number[] = []
  const list = new SelectableList(renderer, { onSelect: (index) => selected.push(index) })
  list.setRows([
    { id: "a", content: "a" },
    { id: "b", content: "b" },
    { id: "c", content: "c" },
  ])
  list.handleKey(key("down"))

  list.setRows(
    [
      { id: "c", content: "c" },
      { id: "a", content: "a" },
      { id: "b", content: "b" },
    ],
    "b",
  )

  expect(list.selectedIndex).toBe(2)
  expect(selected).toEqual([1])

  list.destroy()
  renderer.destroy()
})

test("preserves manual scroll while live data reorders existing rows", async () => {
  const { renderer, renderOnce } = await createTestRenderer({ width: 40, height: 6 })
  const list = new SelectableList(renderer)
  renderer.root.add(list.root)
  const rows = Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}`, content: `row ${index}` }))
  list.setRows(rows)
  await renderOnce()
  list.root.scrollTo({ x: 0, y: 8 })
  await renderOnce()
  const scrollTop = list.root.scrollTop
  expect(scrollTop).toBeGreaterThan(0)

  list.setRows([...rows].reverse(), "row-0", { preserveScroll: true })
  await renderOnce()

  expect(list.root.scrollTop).toBe(scrollTop)
  expect(list.selectedIndex).toBe(19)

  list.destroy()
  renderer.destroy()
})

test("selects a row when it is clicked", async () => {
  const { renderer, mockMouse, renderOnce, captureCharFrame } = await createTestRenderer({ width: 40, height: 10 })
  const selected: number[] = []
  let focusRequests = 0
  const list = new SelectableList(renderer, {
    onSelect: (index) => selected.push(index),
    onFocusRequest: () => focusRequests++,
  })
  renderer.root.add(list.root)
  list.setRows([
    { id: "a", content: "AAA" },
    { id: "b", content: "BBB" },
    { id: "c", content: "CCC" },
  ])
  await renderOnce()
  expect(list.selectedIndex).toBe(0)

  const y = captureCharFrame().split("\n").findIndex((line) => line.includes("CCC"))
  await mockMouse.click(4, y)

  expect(list.selectedIndex).toBe(2)
  expect(selected).toEqual([2])
  expect(focusRequests).toBe(1)

  list.destroy()
  renderer.destroy()
})

test("returns false when there are no rows", async () => {
  const { renderer } = await createTestRenderer({ width: 40, height: 10 })
  const list = new SelectableList(renderer)
  expect(list.handleKey(key("down"))).toBe(false)
  expect(list.selectedIndex).toBe(-1)
  list.destroy()
  renderer.destroy()
})
