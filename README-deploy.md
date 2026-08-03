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

The app receives `APP_PIN`, `SESSION_SECRET`, `SESSION_TTL_DAYS`,
`DEFAULT_ANALYTICS_CURRENCY`, and `FRANKFURTER_URL` from the VPS environment.

The shared PIN is an access gate, not per-user encryption. If the PIN is changed,
rotate `SESSION_SECRET` as well so all existing signed sessions become invalid.
The PWA keeps an offline cache on the device; use offline mode only on trusted,
screen-locked devices and clear the site's browser storage before giving a device
to someone else.

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

2. Fill `.env`. Generate the session secret on the VPS, for example:

   ```bash
   openssl rand -hex 32
   ```

   R2 credentials belong only in this VPS file. Do not add them to GitHub
   secrets, the Docker image, or the repository.

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
