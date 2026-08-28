import { certificateExpiry, issueMutualTlsCertificates } from "./tls.ts"

const USAGE = `Usage:
  bun run server:token            Generate a value for TRBOT_SERVER_TOKEN
  bun run server:cert [host...]   Issue server and client certificates for mutual TLS
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
    const paths = await issueMutualTlsCertificates(hosts)
    const expiry = await certificateExpiry(paths.serverCert)
    const validity = expiry ? ` It is valid for ${expiry.daysRemaining} more day(s), until ${expiry.notAfter.toISOString()}.` : ""
    console.log(`Issued a certificate for ${hosts.join(", ")}.${validity}\n`)
    console.log("The server reads this bundle from data/tls by default.\n")
    console.log("Copy these three files into data/tls on each client:")
    console.log(`  ${paths.caCert}`)
    console.log(`  ${paths.clientCert}`)
    console.log(`  ${paths.clientKey}`)
    return 0
  }

  console.log(USAGE)
  return command ? 1 : 0
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)))
