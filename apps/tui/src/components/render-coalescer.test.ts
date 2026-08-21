import { expect, test } from "bun:test"
import { RenderCoalescer } from "./render-coalescer.ts"

// Yields one event-loop turn, which runs pending immediates.
const nextTurn = () => Bun.sleep(0)

test("a synchronous burst renders once, with the state current at render time", async () => {
  let state = 0
  const rendered: number[] = []
  const coalescer = new RenderCoalescer(() => rendered.push(state))

  for (let event = 1; event <= 200; event++) {
    state = event
    coalescer.schedule()
  }
  expect(rendered).toEqual([])

  await nextTurn()
  expect(rendered).toEqual([200])

  // Nothing new was scheduled, so nothing further renders.
  await nextTurn()
  expect(rendered).toEqual([200])
})

test("a sustained stream renders once per event-loop turn, not once per event", async () => {
  let renders = 0
  const coalescer = new RenderCoalescer(() => renders++)

  for (let turn = 0; turn < 3; turn++) {
    for (let event = 0; event < 50; event++) coalescer.schedule()
    await nextTurn()
  }
  expect(renders).toBe(3)
})

test("cancel drops the pending render and blocks future schedules", async () => {
  let renders = 0
  const coalescer = new RenderCoalescer(() => renders++)

  coalescer.schedule()
  coalescer.cancel()
  await nextTurn()
  coalescer.schedule()
  await nextTurn()
  expect(renders).toBe(0)
})

test("reports an asynchronous render failure without leaking it into the terminal", async () => {
  const failures: unknown[] = []
  const failure = new Error("native render failed")
  const coalescer = new RenderCoalescer(() => {
    throw failure
  }, (error) => failures.push(error))

  coalescer.schedule()
  await nextTurn()

  expect(failures).toEqual([failure])
})
