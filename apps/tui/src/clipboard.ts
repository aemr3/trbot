import type { CliRenderer, Renderable } from "@opentui/core"

export interface ClipboardWriter {
  write(text: string): Promise<void>
}

type SelectionTarget = Renderable & {
  getClipboardText?: (text: string) => string
}

interface SelectionSnapshot {
  getSelectedText(): string
  selectedRenderables: Renderable[]
}

export interface SelectionReader {
  currentFocusedRenderable: Renderable | null
  getSelection(): SelectionSnapshot | null
  clearSelection(): void
}

/** Copies the renderer selection and clears its highlight once it is captured. */
export function copySelection(
  renderer: SelectionReader,
  clipboard: ClipboardWriter,
  onError?: (cause: unknown) => void,
): boolean {
  const selection = renderer.getSelection()
  if (!selection) return false

  const selectedText = selection.getSelectedText()
  if (!selectedText) return false

  // SAFETY: OpenTUI exposes the focused renderable through its base type, while
  // trbot's selectable controls optionally add SelectionTarget.getClipboardText.
  const focused = renderer.currentFocusedRenderable as SelectionTarget | null
  const text = focused?.getClipboardText && selection.selectedRenderables.includes(focused)
    ? focused.getClipboardText(selectedText)
    : selectedText

  void clipboard.write(text).catch((cause: unknown) => onError?.(cause))
  renderer.clearSelection()
  return true
}

/** Writes through OSC52 and the host clipboard, covering local and remote terminals. */
export class SystemClipboard implements ClipboardWriter {
  constructor(private readonly renderer: Pick<CliRenderer, "copyToClipboardOSC52">) {}

  async write(text: string): Promise<void> {
    const copiedThroughTerminal = this.renderer.copyToClipboardOSC52(text)
    const copiedThroughHost = await writeNativeClipboard(text)
    if (!copiedThroughTerminal && !copiedThroughHost) {
      throw new Error("No supported clipboard method is available")
    }
  }
}

async function writeNativeClipboard(text: string): Promise<boolean> {
  const command = nativeClipboardCommand()
  if (!command) return false

  try {
    if (command[0]?.endsWith("osascript")) {
      const child = Bun.spawn([...command, text], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      return await child.exited === 0
    }

    const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
    child.stdin.write(text)
    child.stdin.end()
    return await child.exited === 0
  } catch {
    return false
  }
}

function nativeClipboardCommand(): string[] | null {
  if (process.platform === "darwin") {
    const executable = Bun.which("osascript")
    if (!executable) return null
    return [
      executable,
      "-e",
      "on run argv",
      "-e",
      "set the clipboard to item 1 of argv",
      "-e",
      "end run",
      "--",
    ]
  }

  if (process.platform === "linux" && process.env.WAYLAND_DISPLAY) {
    const executable = Bun.which("wl-copy")
    if (executable) return [executable]
  }

  if (process.platform === "linux") {
    const xclip = Bun.which("xclip")
    if (xclip) return [xclip, "-selection", "clipboard"]
    const xsel = Bun.which("xsel")
    if (xsel) return [xsel, "--clipboard", "--input"]
  }

  if (process.platform === "win32") {
    const executable = Bun.which("powershell.exe")
    if (executable) {
      return [
        executable,
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())",
      ]
    }
  }

  return null
}
