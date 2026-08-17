// The arithmetic behind a watched price level, shared by protective stops and
// price alerts. Everything is expressed as the direction the market has to come
// from, so no caller re-derives long/short or above/below for itself. Getting
// this wrong in one place and right in the other is exactly the bug worth
// spending a module to avoid.

export const LEVEL_DIRECTIONS = ["ABOVE", "BELOW"] as const
export type LevelDirection = (typeof LEVEL_DIRECTIONS)[number]

export function isLevelDirection(value: string): value is LevelDirection {
  return LEVEL_DIRECTIONS.some((direction) => direction === value)
}

/**
 * Moves `anchor` by `distance` toward the watched side. Null when the result is
 * not a price a market could print.
 */
export function offsetLevel(direction: LevelDirection, anchor: number, distance: number): number | null {
  if (!Number.isFinite(anchor) || !Number.isFinite(distance) || distance <= 0) return null
  const level = direction === "BELOW" ? anchor - distance : anchor + distance
  return level > 0 ? level : null
}

/** Whether a price has reached the level from the side being watched. */
export function isLevelReached(direction: LevelDirection, price: number, level: number): boolean {
  if (!Number.isFinite(price) || !Number.isFinite(level)) return false
  return direction === "BELOW" ? price <= level : price >= level
}

/**
 * Whether `next` sits closer to the market than `current`. A trail only ever
 * tightens: a widening ATR must not loosen a level that has already moved.
 */
export function tightensLevel(direction: LevelDirection, current: number | null, next: number): boolean {
  if (current === null) return true
  return direction === "BELOW" ? next > current : next < current
}
