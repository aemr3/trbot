import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core"

export class WatchlistScreen {
  readonly root: BoxRenderable

  constructor(renderer: RenderContext) {
    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      gap: 1,
      padding: 1,
      width: "100%",
      height: "100%",
    })
    this.root.add(
      new TextRenderable(renderer, {
        content: "Watchlist",
        fg: "#70d7a1",
      }),
    )
    this.root.add(
      new TextRenderable(renderer, {
        content: "Ctrl+C to exit",
        fg: "#777777",
      }),
    )
  }

  destroy(): void {
    if (!this.root.isDestroyed) this.root.destroyRecursively()
  }
}
