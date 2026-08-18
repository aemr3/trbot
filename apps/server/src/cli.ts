import { certificateExpiry, issueServerCertificate } from "./tls.ts"

const USAGE = `Usage:
  bun run server:token            Generate a value for TRBOT_SERVER_TOKEN
  bun run server:cert [host...]   Issue a server certificate, creating the authority on first use
`

/** Generates a 256-bit token, the value TRBOT_SERVER_TOKEN expects. */
function generateToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
}

async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  if (command === "token") {
    console.log(generateToken())
    return 0
  }

  if (command === "cert") {
    const hosts = rest.length > 0 ? rest : ["127.0.0.1", "localhost"]
    const paths = await issueServerCertificate(hosts)
    const expiry = await certificateExpiry(paths.serverCert)
    const validity = expiry ? ` It is valid for ${expiry.daysRemaining} more day(s), until ${expiry.notAfter.toISOString()}.` : ""
    console.log(`Issued a certificate for ${hosts.join(", ")}.${validity}\n`)
    console.log("Point the server at it:")
    console.log(`  TRBOT_SERVER_TLS_CERT=${paths.serverCert}`)
    console.log(`  TRBOT_SERVER_TLS_KEY=${paths.serverKey}\n`)
    console.log("Point each client at the authority so it trusts the server:")
    console.log(`  TRBOT_SERVER_CA=${paths.caCert}`)
    return 0
  }

  console.log(USAGE)
  return command ? 1 : 0
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)))
