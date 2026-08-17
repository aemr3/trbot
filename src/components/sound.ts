// Audible cues for the two things a trader must not miss while looking at
// something else: a price alert reaching its level, and a protective stop about
// to send a live order. They are deliberately different sounds — hearing which
// one fired should not require looking at the screen.

export const SOUND_CUES = ["ALERT", "STOP"] as const
export type SoundCue = (typeof SOUND_CUES)[number]

export interface SoundPlayer {
  play(cue: SoundCue): void
}

// macOS ships distinct system sounds, so each cue gets its own voice: the alert
// pings, the stop is the sharper one because money is about to move.
const MACOS_SOUND_FILES: Record<SoundCue, string> = {
  ALERT: "/System/Library/Sounds/Submarine.aiff",
  STOP: "/System/Library/Sounds/Sosumi.aiff",
}

// Where no sound player is available the terminal bell stands in, twice for a
// stop, so the two cues stay apart even at their most primitive.
const BELL = "\u0007"
const BELL_COUNT: Record<SoundCue, number> = { ALERT: 1, STOP: 2 }

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
