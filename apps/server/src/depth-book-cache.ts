import type {
  DepthBook,
  DepthBookSnapshot,
  DepthBookSnapshotSource,
} from "@trbot/market/depth.ts"

/** Retains the latest book that the server delivered to a client. */
export class LiveDepthBookCache implements DepthBookSnapshotSource {
  private readonly snapshots = new Map<string, DepthBookSnapshot>()

  constructor(private readonly now: () => number = Date.now) {}

  accept(book: DepthBook): void {
    this.snapshots.set(normalizeSymbol(book.symbol), {
      book,
      updatedAt: this.now(),
    })
  }

  getDepthBookSnapshot(symbol: string): DepthBookSnapshot | null {
    return this.snapshots.get(normalizeSymbol(symbol)) ?? null
  }
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}
