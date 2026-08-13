# Moapp

Mobile-first expense tracker with isolated account workspaces for households and
small groups. A browser holds one passwordless profile at a time; that profile
can belong to several workspaces and switch between them locally. The primary
data lives in SQLite and is replicated to Cloudflare R2.

## Development

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run build
npm test
```

The repository is split into two workspaces:

- `client` — React/Vite progressive web app;
- `server` — Fastify API, SQLite storage, profile sessions, workspaces, and
  exchange rates.

Deployment files live in `infra`, with the production workflow in
`.github/workflows`.

## Product defaults

- Passwordless profiles with one or more isolated workspaces.
- Separate invitation links for people, device links for another browser, and a
  personal recovery link for restoring the profile and all remaining
  memberships.
- Capability links use URL fragments (`#/join/...`, `#/device/...`, and
  `#/recover/...`) so their secrets are not sent in the HTTP URL.
- RSD as the default expense and analytics currency.
- Frankfurter v2 for daily and historical exchange rates.
- SQLite as the primary database.
- Cloudflare R2 as off-server backup storage.
- Host Nginx terminates HTTPS and proxies to `127.0.0.1:8892`.

The recovery link is the profile's long-lived master secret. Save it somewhere
private before relying on the profile, never share it as an invitation, and
rotate it if it may have been exposed. Each browser can hold only one profile;
connecting a device link for another profile requires explicitly signing out
and clearing that browser's local Moapp data.

See [README-deploy.md](./README-deploy.md) after the infrastructure files have
been configured.
