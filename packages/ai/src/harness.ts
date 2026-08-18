import manifest from "../package.json"

/**
 * The model harness version stamped on every stored chat message.
 *
 * Read from this package's own pinned dependency rather than written out by hand,
 * because the process that stamps the rows is the server, which does not declare
 * the harness at all — a hand-written copy there would keep reporting the old
 * version after an upgrade, and a row that names the wrong version is worse than
 * one that names none. Exact because the pin is exact.
 */
export const HARNESS_VERSION = `pi-ai/${manifest.dependencies["@mariozechner/pi-ai"]}`
