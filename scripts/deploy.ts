import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { workspaceRoot } from "@trbot/config"

const REVISION_PATTERN = /^[0-9a-f]{40}$/

/** Packages one committed revision and sends it to the restricted server deploy command. */
async function deploy(): Promise<void> {
  const root = workspaceRoot()
  const target = process.env.TRBOT_DEPLOY_TARGET?.trim() || "dev"
  const revision = process.env.TRBOT_DEPLOY_REVISION?.trim() || (await output(["git", "rev-parse", "HEAD"], root))
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "trbot-deploy-"))
  const archive = join(temporaryDirectory, "release.tar")
  const revisionFile = join(temporaryDirectory, ".trbot-revision")

  if (!REVISION_PATTERN.test(revision)) throw new Error(`Invalid deployment revision: ${revision}`)

  try {
    await writeFile(revisionFile, `${revision}\n`, { mode: 0o600 })
    await run(["git", "archive", "--format=tar", `--output=${archive}`, revision], root)
    await run(["tar", "--append", `--file=${archive}`, "-C", temporaryDirectory, ".trbot-revision"], root)

    const ssh = Bun.spawn({
      cmd: sshCommand(target),
      cwd: root,
      stdin: Bun.file(archive),
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await ssh.exited
    if (exitCode !== 0) throw new Error(`Deployment failed with exit code ${exitCode}`)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function sshCommand(target: string): string[] {
  const command = ["ssh", "-o", "BatchMode=yes"]
  const port = process.env.TRBOT_DEPLOY_PORT?.trim()
  const identity = process.env.TRBOT_DEPLOY_IDENTITY?.trim()
  const knownHosts = process.env.TRBOT_DEPLOY_KNOWN_HOSTS?.trim()

  if (port) command.push("-p", port)
  if (identity) command.push("-i", identity, "-o", "IdentitiesOnly=yes")
  if (knownHosts) command.push("-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes")
  command.push(target, "/usr/bin/sudo", "-n", "-u", "trbot", "/home/trbot/bin/deploy")
  return command
}

async function output(command: string[], cwd: string): Promise<string> {
  const processHandle = Bun.spawn({ cmd: command, cwd, stdout: "pipe", stderr: "inherit" })
  const text = await new Response(processHandle.stdout).text()
  const exitCode = await processHandle.exited
  if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}`)
  return text.trim()
}

async function run(command: string[], cwd: string): Promise<void> {
  const processHandle = Bun.spawn({ cmd: command, cwd, stdout: "inherit", stderr: "inherit" })
  const exitCode = await processHandle.exited
  if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}`)
}

await deploy()
