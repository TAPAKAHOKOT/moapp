# Moapp

Mobile-first shared expense tracker for a small household. The application uses
a shared PIN instead of user accounts, keeps its primary data in SQLite, and
replicates backups to Cloudflare R2.

## Development

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run build
npm test
```

The repository is split into two workspaces:

- `client` — React/Vite progressive web app;
- `server` — Fastify API, SQLite storage, PIN sessions, and exchange rates.

Deployment files live in `infra`, with the production workflow in
`.github/workflows`.

## Product defaults

- Shared data and one shared PIN, without accounts.
- RSD as the default expense and analytics currency.
- Frankfurter v2 for daily and historical exchange rates.
- SQLite as the primary database.
- Cloudflare R2 as off-server backup storage.
- Host Nginx terminates HTTPS and proxies to `127.0.0.1:8892`.

See [README-deploy.md](./README-deploy.md) after the infrastructure files have
been configured.
