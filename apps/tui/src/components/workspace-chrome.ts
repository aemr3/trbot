import { TUI_THEME } from "../theme.ts"
// The workspace chrome — the tab bar across the top and the footer of every
// screen — is a vivid indigo band so it reads as a frame around the near-black
// panels. Text placed on it needs these foreground colors, not the muted greys
// the panels use, to stay legible.
const WORKSPACE_CHROME_BACKGROUND = TUI_THEME.chromeBackground
const WORKSPACE_ACTIVE_BACKGROUND = TUI_THEME.chromeActive
export const WORKSPACE_CHROME_TEXT = TUI_THEME.textStrong
export const WORKSPACE_CHROME_MUTED = TUI_THEME.chromeMuted

// Outside the live session the frame recedes behind the market data instead of
// suggesting that prices are still moving.
export const WORKSPACE_CLOSED_CHROME_BACKGROUND = TUI_THEME.chromeClosedBackground
export const WORKSPACE_CLOSED_ACTIVE_BACKGROUND = TUI_THEME.chromeClosedActive

export function workspaceChromeBackground(marketOpen: boolean | null): string {
  return marketOpen === false ? WORKSPACE_CLOSED_CHROME_BACKGROUND : WORKSPACE_CHROME_BACKGROUND
}

export function workspaceActiveBackground(marketOpen: boolean | null): string {
  return marketOpen === false ? WORKSPACE_CLOSED_ACTIVE_BACKGROUND : WORKSPACE_ACTIVE_BACKGROUND
}
