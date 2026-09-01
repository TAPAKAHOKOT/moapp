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

## ChatGPT and MCP

The production server exposes a read-only MCP endpoint at `${APP_ORIGIN}/mcp`.
It lets ChatGPT list the connected profile's current workspaces and read
filtered, paginated expense history. It cannot create, edit, or delete data.

Authentication is a small OAuth 2.1 authorization-code flow built into Moapp:
dynamic client registration, S256 PKCE, one-hour access tokens, rotating
30-day refresh tokens, and the single `history:read` scope. OAuth tokens and
codes are stored only as SHA-256 hashes. The consent page reuses the existing
Moapp browser session, so no email/password provider or additional deployment
configuration is required.

To test it, deploy the app over HTTPS, enable developer mode in ChatGPT, and
add `${APP_ORIGIN}/mcp` as the MCP server URL. Open Moapp in the same browser
profile first. Because the application cookie is deliberately
`SameSite=Strict`, the first authorization page may ask for one extra
"Продолжить" click before showing consent.

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
- Read-only MCP access with built-in OAuth 2.1 and live workspace membership checks.
- Host Nginx terminates HTTPS and proxies to `127.0.0.1:8892`.

The recovery link is the profile's long-lived master secret. Save it somewhere
private before relying on the profile, never share it as an invitation, and
rotate it if it may have been exposed. Each browser can hold only one profile;
connecting a device link for another profile requires explicitly signing out
and clearing that browser's local Moapp data.

See [README-deploy.md](./README-deploy.md) after the infrastructure files have
been configured.
