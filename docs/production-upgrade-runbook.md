# Production upgrade runbook: DeBOS Google launch fork

This runbook upgrades the existing production Blocklet Server in place while protecting the current live instances.

The current high-value canary is:

- `https://debos.12inchapps.com/?locale=en`

If that URL fails after the upgrade, roll back immediately.

## Production context

- Production server admin origin: `https://165-227-28-128.ip.abtnet.io`
- Production server home: `/srv/blocklet-server/.blocklet-server`
- Production webapp runtime: `/usr/lib/node_modules/@blocklet/cli/node_modules/@abtnode/webapp`
- Marketing page / current DeBOS site: `https://debos.12inchapps.com`
- Store: `https://appstore.12inchapps.com`
- DeBOS-only launch DID: `z8iZzXUyiJYiDZP3nhMVMN3eeXnZZ6dokUk2B`

## Safety gates

Before running the deploy with `--apply`:

1. Take a DigitalOcean droplet snapshot.
2. Confirm `https://debos.12inchapps.com/?locale=en` loads.
3. Confirm `https://appstore.12inchapps.com/?locale=en` loads.
4. Run preflight:

```bash
cd /Users/marioperea/Desktop/blocklet-server
./scripts/production/preflight.sh
```

The scripts auto-use `~/.ssh/debos_azure_smoke` when present. Override with:

```bash
PROD_SSH_KEY=/path/to/key ./scripts/production/preflight.sh
```

## Dry run

The deploy script is dry-run by default. It builds the artifact and stops before uploading.

```bash
cd /Users/marioperea/Desktop/blocklet-server
./scripts/production/deploy-fork.sh
```

## Deploy

Only run this after the droplet snapshot is complete.

```bash
cd /Users/marioperea/Desktop/blocklet-server
SNAPSHOT_CONFIRMED=yes ./scripts/production/deploy-fork.sh --apply
```

The deploy script:

1. Runs preflight.
2. Builds `core/webapp/blocklet.js`.
3. Creates a timestamped artifact.
4. Uploads the artifact to the server.
5. Backs up the current `@abtnode/webapp` runtime on the server.
6. Installs the forked runtime.
7. Restarts `abt-node-service` and `abt-node-daemon`.
8. Runs public smoke tests.

## Smoke test

Run this anytime:

```bash
cd /Users/marioperea/Desktop/blocklet-server
./scripts/production/smoke-test.sh
```

It verifies:

- `https://debos.12inchapps.com/?locale=en`
- `https://appstore.12inchapps.com/?locale=en`
- production admin origin
- Google DeBOS launch config endpoint

## Rollback

Use the `BACKUP_DIR` printed by the deploy script.

```bash
cd /Users/marioperea/Desktop/blocklet-server
BACKUP_DIR=/root/blocklet-fork-backups/YYYYMMDD-HHMMSS ./scripts/production/rollback-fork.sh
```

After rollback, re-run:

```bash
./scripts/production/smoke-test.sh
```

## Notes

- This upgrade preserves the server data directory and installed blocklets.
- The script updates the Blocklet Server runtime code, not the blocklet instance data.
- Do not run `--apply` without a fresh droplet snapshot.
- Keep the production Google OAuth client secret out of git. Configure it on the server runtime/env only.
- Production must define `DEBOS_GOOGLE_CLIENT_ID`, `DEBOS_GOOGLE_CLIENT_SECRET`, and the canonical HTTPS
  `DEBOS_GOOGLE_BROKER_URL` before Google launch is considered live.
- Treat a Blocklet Server host operator as part of the tenant trust boundary. Do not claim zero-knowledge or
  zero-operator-access isolation unless tenant-held encryption keys and an independently enforced break-glass process exist.
