export interface RendererOutput {
  writeOut(data: string): void
}

/** Exposes OpenTUI's runtime output channel, which its public typings mark private. */
export function rendererOutput<T extends NonNullable<object>>(renderer: T): RendererOutput {
  // SAFETY: CliRenderer and its RenderContext callbacks carry writeOut at runtime.
  return renderer as RendererOutput
}
