# Server operations

The files in this directory reproduce the Bun server service used on the VPS.
They contain no credentials, private keys, certificates, or database data.

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

The server listens with mutual TLS on its public interface, port 7717. It runs as the no-login `trbot` user, uses the existing Linuxbrew Bun at `/home/linuxbrew/.linuxbrew/bin/bun`, and keeps releases plus persistent state under `/home/trbot`.
The installer never invokes the system package manager or installs Bun. The existing system `curl` performs the local health check with the generated client certificate.

Set `TRBOT_SERVER_TLS_HOSTS` in the protected server environment to the
space-separated DNS names or IP addresses clients use. The systemd service adds
those names to the server certificate without storing deployment-specific
addresses in the repository.

The service issues `ca.crt`, `server.crt`, `server.key`, `client.crt`, and
`client.key` under `/home/trbot/shared/tls` before startup. Copy only `ca.crt`,
`client.crt`, and `client.key` to the terminal through an authenticated
administrator connection; never copy `ca.key`. Protect the copied client key
with mode `0600` and place all three files under the terminal's `data/tls`
directory. An HTTPS server URL loads them without additional path settings.

When upgrading an existing installation from ordinary TLS to mutual TLS, rerun
`sudo deploy/server/install --env-file /path/to/trbot.env` from the updated
checkout before `bun run deploy`. This refreshes the installed health check and
service environment before the mTLS server starts.

The default server uninstall preserves configuration and runtime data:

```sh
sudo deploy/server/uninstall
```

Deleting the database, credentials, and TLS material requires the explicit `--purge-data` option.
Removing the `trbot` Unix user and its complete home directory requires both `--purge-data` and `--remove-user`.
