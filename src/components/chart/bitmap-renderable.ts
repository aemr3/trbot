// Displays a pre-rasterized chart bitmap through the terminal's kitty graphics
// protocol. Mirrors OpenTUI's ImageRenderable, but takes raw RGBA frames from
// the chart rasterizer instead of an encoded image source.
import {
  NativeImage,
  Renderable,
  resolveImageRenderProtocol,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from "@opentui/core"
import type { CandleChartBitmap } from "./raster.ts"

/** Pixel size of one terminal cell, when the terminal reports its resolution. */
function cellPixelSize(ctx: RenderContext): { width: number; height: number } | null {
  const resolution = ctx.resolution
  const columns = ctx.terminalWidth ?? ctx.width
  const rows = ctx.terminalHeight ?? ctx.height
  if (!resolution || !columns || !rows) return null
  const width = resolution.width / columns
  const height = resolution.height / rows
  return width > 0 && height > 0 ? { width, height } : null
}

export interface ChartBitmapSupport {
  /**
   * "direct": OpenTUI draws the image itself (cursor-positioned placements).
   * "placeholder": inside tmux those placements land in the wrong place, so
   * the image goes through tmux passthrough and unicode placeholder cells.
   */
  mode: "direct" | "placeholder"
  cellPixel: { width: number; height: number }
}

/** How the chart may render as a kitty bitmap, or null for the braille fallback. */
export function chartBitmapSupport(ctx: RenderContext): ChartBitmapSupport | null {
  const cellPixel = cellPixelSize(ctx)
  if (!cellPixel) return null
  const capabilities = ctx.capabilities
  if (capabilities?.multiplexer === "tmux") {
    return capabilities.kitty_graphics ? { mode: "placeholder", cellPixel } : null
  }
  // Defers to OpenTUI's protocol resolution, which honors an explicit
  // image_protocol override; anything but kitty falls back to braille.
  return resolveImageRenderProtocol("auto", capabilities ?? null, true) === "kitty"
    ? { mode: "direct", cellPixel }
    : null
}

export class ChartBitmapRenderable extends Renderable {
  private image: NativeImage | null = null

  constructor(ctx: RenderContext, options: RenderableOptions<ChartBitmapRenderable>) {
    super(ctx, options)
  }

  /** Swaps in a freshly rasterized frame; null clears the display. */
  setBitmap(bitmap: CandleChartBitmap | null): void {
    const previous = this.image
    this.image = bitmap ? NativeImage.fromRgba(bitmap.pixels, bitmap.width, bitmap.height) : null
    previous?.dispose()
    this.requestRender()
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    const image = this.image
    if (!image || this.width <= 0 || this.height <= 0) return
    // The bitmap is rasterized at this renderable's exact pixel size, so it
    // maps onto the cell area without scaling.
    buffer.drawImage(
      image,
      this._screenX,
      this._screenY,
      this.width,
      this.height,
      image.width,
      image.height,
      0,
      0,
      image.width,
      image.height,
      "kitty",
    )
  }

  protected destroySelf(): void {
    this.image?.dispose()
    this.image = null
    super.destroySelf()
  }
}
