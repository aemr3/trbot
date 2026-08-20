import { expect, test } from "bun:test"
import { SystemSoundPlayer } from "./sound.ts"

function player(overrides: { platform?: string; spawn?: (command: string[]) => void } = {}) {
  const commands: string[][] = []
  const written: string[] = []
  const sound = new SystemSoundPlayer({
    platform: overrides.platform ?? "darwin",
    spawn: overrides.spawn ?? ((command) => commands.push(command)),
    write: (data) => written.push(data),
  })
  return { sound, commands, written }
}

test("the cues use different system sounds", () => {
  const { sound, commands } = player()

  sound.play("ALERT")
  sound.play("STOP")
  sound.play("COMPLETE")
  sound.play("QUESTION")
  sound.play("NOTIFICATION")

  // Which one fired has to be clear without looking at the screen.
  expect(commands[0]?.[0]).toBe("afplay")
  expect(commands[0]?.[1]).not.toBe(commands[1]?.[1])
  expect(commands[2]?.[1]).not.toBe(commands[0]?.[1])
  expect(commands[2]?.[1]).not.toBe(commands[1]?.[1])
  expect(new Set(commands.map((command) => command[1])).size).toBe(5)
})

test("falls back to the terminal bell where no player exists", () => {
  const { sound, commands, written } = player({ platform: "linux" })

  sound.play("ALERT")
  sound.play("STOP")

  expect(commands).toEqual([])
  // Still two distinct cues: one bell against two.
  expect(written).toEqual(["\u0007", "\u0007\u0007"])
})

test("a player that will not start is not retried on every trigger", () => {
  let attempts = 0
  const { sound, written } = player({
    spawn: () => {
      attempts += 1
      throw new Error("afplay is missing")
    },
  })

  sound.play("ALERT")
  sound.play("ALERT")

  // Retrying a missing player would stall the tick that fired the alert.
  expect(attempts).toBe(1)
  expect(written).toHaveLength(2)
})
