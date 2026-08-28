/** PEM material used by both HTTP and WebSocket client handshakes. */
export interface ClientTlsOptions {
  /** Omit this to use the operating system trust store for the server. */
  ca?: string
  cert: string
  key: string
}
