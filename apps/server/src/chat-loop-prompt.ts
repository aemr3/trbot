import { resolve } from "node:path"
import { workspaceRoot } from "@trbot/config"

const MAX_PROMPT_BYTES = 25_000

/** Loads the project default first, then the installation-wide default under data/. */
export async function loadDefaultLoopPrompt(): Promise<string | null> {
  const root = workspaceRoot()
  for (const path of [resolve(root, ".trbot/loop.md"), resolve(root, "data/loop.md")]) {
    try {
      const file = Bun.file(path)
      if (!(await file.exists())) continue
      const prompt = (await file.slice(0, MAX_PROMPT_BYTES).text()).trim()
      if (prompt) return prompt
    } catch {
      // A missing or temporarily unreadable customization must not stall the scheduler.
    }
  }
  return null
}
