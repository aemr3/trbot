// Audible cues for events worth noticing while looking at something else. They
// use different system sounds so the urgent market cues remain recognizable.

const SOUND_CUES = ["ALERT", "STOP", "COMPLETE", "QUESTION", "PERMISSION", "NOTIFICATION"] as const
export type SoundCue = (typeof SOUND_CUES)[number]

export interface SoundPlayer {
  play(cue: SoundCue): void
}

// The completion sound is deliberately gentler than the market cues.
const MACOS_SOUND_FILES = {
  ALERT: "/System/Library/Sounds/Submarine.aiff",
  STOP: "/System/Library/Sounds/Sosumi.aiff",
  COMPLETE: "/System/Library/Sounds/Pop.aiff",
  QUESTION: "/System/Library/Sounds/Ping.aiff",
  PERMISSION: "/System/Library/Sounds/Hero.aiff",
  NOTIFICATION: "/System/Library/Sounds/Glass.aiff",
} satisfies Record<SoundCue, string>

// Where no sound player is available the terminal bell stands in, twice for a
// stop, so the two cues stay apart even at their most primitive.
const BELL = "\u0007"
const BELL_COUNT = { ALERT: 1, STOP: 2, COMPLETE: 1, QUESTION: 1, PERMISSION: 1, NOTIFICATION: 1 } satisfies Record<SoundCue, number>

export interface SystemSoundPlayerOptions {
  // Writes raw terminal output. Pass the renderer's writer so a bell never
  // races a frame being drawn; the default writes straight to stdout.
  write?: (data: string) => void
  // Starts a detached process. Injectable so tests never spawn anything.
  spawn?: (command: string[]) => void
  platform?: string
}

export class SystemSoundPlayer implements SoundPlayer {
  private soundsUnavailable = false

  constructor(private readonly options: SystemSoundPlayerOptions = {}) {}

  play(cue: SoundCue): void {
    if (this.playSystemSound(cue)) return
    this.bell(cue)
  }

  /** True when the cue was handed to a real sound player. */
  private playSystemSound(cue: SoundCue): boolean {
    if (this.soundsUnavailable) return false
    const platform = this.options.platform ?? process.platform
    if (platform !== "darwin") {
      this.soundsUnavailable = true
      return false
    }
    try {
      const start = this.options.spawn ?? startDetached
      start(["afplay", MACOS_SOUND_FILES[cue]])
      return true
    } catch {
      // One failure is enough: a missing player will not appear later, and
      // retrying it on every trigger would stall the tick that fired.
      this.soundsUnavailable = true
      return false
    }
  }

  private bell(cue: SoundCue): void {
    const write = this.options.write ?? ((data: string) => void process.stdout.write(data))
    try {
      write(BELL.repeat(BELL_COUNT[cue]))
    } catch {
      // A terminal that will not take a bell is not worth reporting: the popup
      // still shows, which is the part that matters.
    }
  }
}

function startDetached(command: string[]): void {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  // The sound outlives the call but must never hold the process open.
  child.unref()
}
