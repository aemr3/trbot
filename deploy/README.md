# Server operations

The files in this directory reproduce the isolated Tailscale client and the Bun server service used on the VPS.
They contain no credentials, private keys, certificates, Tailscale state, or database data.

## Tailscale namespace

Install or refresh the isolated namespace from a repository checkout on the VPS:

```sh
sudo deploy/tailscale/install
```

The default uninstall logs the node out and removes its state. Use `--keep-state` when reinstalling:

```sh
sudo trbot-tailscale-uninstall --keep-state
```

## Server

Install the runtime and copy an existing environment file into the protected server configuration:

```sh
sudo deploy/server/install --env-file /path/to/trbot.env
```

An optional deployment public key can be restricted to the deploy command:

```sh
sudo deploy/server/install --deploy-key /path/to/deploy.pub
```

Deploy the current committed revision through the SSH target named `dev`:

```sh
bun run deploy
```

The server listens with HTTPS on port 7717 inside `/run/netns/trbot`. It runs as the no-login `trbot` user, uses the existing Linuxbrew Bun at `/home/linuxbrew/.linuxbrew/bin/bun`, and keeps releases plus persistent state under `/home/trbot`.
The installer never invokes the system package manager or installs Bun. The existing system `curl` performs the local HTTPS health check.

The default server uninstall preserves configuration and runtime data:

```sh
sudo deploy/server/uninstall
```

Deleting the database, credentials, and TLS material requires the explicit `--purge-data` option.
Removing the `trbot` Unix user and its complete home directory requires both `--purge-data` and `--remove-user`.
