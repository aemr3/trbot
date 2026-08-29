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

test("frame scheduling keeps the latest state and caps sustained rebuilds", async () => {
  let state = 0
  const rendered: number[] = []
  const coalescer = new RenderCoalescer(() => rendered.push(state))

  state = 1
  coalescer.scheduleFrame()
  await nextTurn()
  expect(rendered).toEqual([1])

  for (let event = 2; event <= 100; event++) {
    state = event
    coalescer.scheduleFrame()
    await nextTurn()
  }
  expect(rendered).toEqual([1])

  await Bun.sleep(40)
  expect(rendered).toEqual([1, 100])
})

test("an immediate schedule accelerates a pending frame without rendering twice", async () => {
  let renders = 0
  const coalescer = new RenderCoalescer(() => renders++)

  coalescer.scheduleFrame()
  await nextTurn()
  coalescer.scheduleFrame()
  coalescer.schedule()
  await nextTurn()
  expect(renders).toBe(2)

  await Bun.sleep(40)
  expect(renders).toBe(2)
})

test("an immediate render does not delay the first live frame", async () => {
  let renders = 0
  const coalescer = new RenderCoalescer(() => renders++)

  coalescer.schedule()
  await nextTurn()
  coalescer.scheduleFrame()
  await nextTurn()

  expect(renders).toBe(2)
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
