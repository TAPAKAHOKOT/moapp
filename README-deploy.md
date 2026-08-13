# Production deployment

The production shape is intentionally small:

```text
Internet -> existing host Nginx/Certbot -> 127.0.0.1:8892
                                           -> app -> SQLite volume
                                                  -> Litestream -> private R2
```

No firewall, Caddy, database server, or existing VPS service is modified by this
repository. The container port is published on loopback only.

## Application contract

The root Dockerfile expects the application to provide these stable contracts:

- `npm ci`, `npm run build`, and `npm run start`;
- production output in `client/dist/` and `server/dist/`;
- `HOST=0.0.0.0`, `PORT=3000` support;
- SQLite path from `DATABASE_PATH=/data/moapp.sqlite`;
- a `GET /api/health` endpoint returning a 2xx response when ready.

The app receives its public origin, session settings, access-link limits,
currency defaults, and backup credentials from the VPS environment.
`APP_ORIGIN` is required in production and must be the exact public `http` or
`https` origin without a path, query, or fragment. `SESSION_SECRET` must contain
at least 32 characters; generate a random value and keep it stable during normal
deployments, because rotating it invalidates every signed browser session.

`APP_PIN` is only a transitional bridge for a database upgraded from the shared
PIN release. It is required while that database's legacy claim is open or
pending, and startup deliberately fails if it is missing then. After the legacy
owner completes recovery and the claim is closed, remove `APP_PIN` from `.env`;
Compose does not require it for subsequent starts. The old PIN login and old
unscoped expense/category/analytics/sync APIs return `410 UPGRADE_REQUIRED` and
must not be used as a rollback access path.

Each browser holds one passwordless profile at a time. A profile can belong to
multiple isolated workspaces. Invitations add another person to one workspace;
device links connect another browser to the same profile; recovery restores the
profile and all memberships that still belong to it. Their canonical browser
URLs keep secrets in fragments: `#/join/SECRET`, `#/device/SECRET`, and
`#/recover/SECRET`.

The recovery URL is a long-lived profile master secret. The user must save the
new URL privately before completing setup or rotation. Never use it as an
invitation or place it in tickets, logs, screenshots, or server configuration;
rotate it immediately if exposure is suspected. The PWA keeps workspace-scoped
offline data on the device, so use it only on trusted, screen-locked devices and
explicitly sign out and clear local Moapp data before connecting a different
profile or transferring the device.

The optional access controls use these defaults unless overridden in `.env`:

| Variable | Default | Meaning |
|---|---:|---|
| `INVITATION_TTL_HOURS` | 72 | Invitation lifetime; accepted values remain limited to 24–168 hours |
| `MAX_ACTIVE_INVITATIONS` | 20 | Active invitations allowed per workspace |
| `DEVICE_LINK_TTL_MINUTES` | 15 | One-time device-link lifetime |
| `RECOVERY_ROTATION_TTL_MINUTES` | 30 | Pending recovery-rotation lifetime |
| `LEGACY_CLAIM_TTL_MINUTES` | 30 | Hard lifetime of a restricted legacy-claim session |
| `ACCESS_PREVIEW_RATE_LIMIT_PER_MINUTE` | 20 | Preview/accept requests per IP per minute |
| `INVITATION_RATE_LIMIT_PER_HOUR` | 10 | Invitation creation limit per workspace per hour |
| `DEVICE_LINK_RATE_LIMIT_PER_HOUR` | 5 | Device-link creation limit per user per hour |
| `RECOVERY_PREPARE_RATE_LIMIT_PER_15_MINUTES` | 5 | Public recovery prepares per IP per 15 minutes |
| `MANUAL_RECOVERY_RATE_LIMIT_PER_HOUR` | 3 | Manual recovery rotations per user per hour |

## First VPS setup

These steps deliberately leave the existing Nginx configuration alone until you
copy and enable the dedicated site yourself.

1. Create the deployment directory and private environment file:

   ```bash
   sudo mkdir -p /opt/moapp/infra/nginx
   sudo chown "$USER":"$USER" /opt/moapp
   cd /opt/moapp
   cp .env.example .env
   chmod 600 .env
   ```

2. Fill `.env`. Set `APP_ORIGIN` to the final HTTPS origin and generate the
   session secret on the VPS, for example:

   ```bash
   openssl rand -hex 32
   ```

   R2 credentials and `SESSION_SECRET` belong only in this VPS file. Do not add
   them to GitHub secrets, the Docker image, or the repository. Keep `APP_PIN`
   only for a legacy cutover; a clean install can remove that line immediately.

3. In Cloudflare R2, create a private `moapp-backups` bucket and an API token
   scoped to Object Read & Write for that bucket. Put the account ID, access key,
   and secret in `.env`. Litestream performs the 90-day cleanup, so do not add a
   shorter R2 lifecycle rule. Bucket versioning/retention locks are optional and
   should be configured with their storage implications understood.

4. Create `/var/www/certbot/.well-known/acme-challenge`, copy
   `infra/nginx/moapp.conf` to `/etc/nginx/sites-available/moapp.conf`, enable it
   using your current Nginx convention, check with `sudo nginx -t`, and reload
   Nginx. After DNS points to the VPS, use Certbot's webroot authenticator with
   `/var/www/certbot` and its Nginx installer to add HTTPS. If the final domain
   is not `moapp.tapakahokot.com`, replace `server_name` and `APP_ORIGIN` first.
   The upstream stays `http://127.0.0.1:8892`.

5. Add GitHub environment `production` and repository/environment secrets:

   - `VPS_HOST`
   - `VPS_USER` (must be able to run Docker without interactive sudo)
   - `VPS_SSH_KEY`
   - `VPS_SSH_PORT` (optional; defaults to `22`)
   - `VPS_DEPLOY_PATH` (optional; defaults to `/opt/moapp`)

The deploy workflow uploads only Compose, `.dockerignore`, and backup-support
files. It never uploads or overwrites `.env`; the maintenance image build context
is restricted to `infra/`. The workflow pulls the immutable commit-tagged app
image, starts the services, and checks `http://127.0.0.1:8892/api/health` on the
VPS.

## Account/workspace cutover

The account/workspace schema replaces shared PIN sessions with profiles and tenant-scoped
workspaces. Deploy the server and client together; neither the new schema nor
either side of the HTTP cutover is safe to roll out independently. A push to
`main` starts the production workflow, so do not push the cutover commit until
every gate below is complete.

Before the first account/workspace start:

1. Confirm the compatibility client release has already been deployed and that
   every known device has opened it and synchronized its old offline queue. If
   an unknown or unavailable device may still hold unsynchronized data, record
   and explicitly accept that residual data-loss risk before continuing.
2. Stop writes and confirm Litestream has replicated the latest database.
3. Run the backup verification command below and preserve an additional
   pre-cutover snapshot or copy of the SQLite volume outside the live volume.
4. Confirm the volume has free space for roughly a second copy of the domain
   tables plus SQLite WAL growth during migration.
5. Keep the existing `APP_PIN` in `/opt/moapp/.env`, set the exact production
   `APP_ORIGIN`, and keep the current `SESSION_SECRET` unless an incident
   explicitly requires rotation.

On startup the migration atomically moves existing expenses, categories, and
sync results into one legacy workspace named `Основное`. Old shared-PIN sessions
are discarded. The first successful legacy claim receives a restricted session
and must save and complete recovery before it can read workspace data. Once that
claim is closed and recovery has been verified from the UI, remove `APP_PIN` and
restart; all ordinary access then uses profile sessions.

Do not roll an old application image forward against the migrated database.
To roll back the cutover, stop all services, preserve the failed volume for
investigation, and restore the pre-cutover database into a fresh volume before
starting the old image. Never overwrite the only migrated copy in place. Restoring an
older database can resurrect previously active sessions or capability records,
so rotate `SESSION_SECRET`, revoke/replace outstanding invitation and device
links after returning to the new release, and have users rotate recovery links
if the restored backup or its credentials may have been exposed.

## Backups and recovery

Litestream continuously copies committed SQLite changes to R2, creates a full
snapshot every 24 hours, validates the replica daily, and keeps 2160 hours (90
days) of point-in-time recovery data. On a new/empty volume, the one-shot
`volume-init` service grants the unprivileged app/Litestream user access and the
one-shot `restore` service restores the latest R2 state (with an integrity check)
before the app starts. It never overwrites an existing database.

GitHub Actions performs a weekly end-to-end restore into an isolated tmpfs, runs
SQLite `PRAGMA quick_check`, and requires the restored `backup_heartbeat` written
by the app to be no older than 48 hours. This catches a valid but stale replica,
not only corrupt or unavailable backup objects. A backup created before heartbeat
support intentionally fails with a clear message until a fresh heartbeat has
been replicated. The check never touches the live database. It can also be run
manually from the Actions page or directly on the VPS:

```bash
cd /opt/moapp
docker compose --env-file .env --profile maintenance run --rm --build backup-verify
```

Inspect backup service health and recent logs:

```bash
cd /opt/moapp
docker compose ps
docker compose logs --tail=100 litestream
```

To restore manually, stop the app, preserve the current volume before making any
changes, and follow the Litestream restore procedure. The automatic restore is
the safer normal path: point a fresh Compose project at an empty volume and let
the `restore` service complete before the app starts.
