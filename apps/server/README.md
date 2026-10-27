# MDCz Server

`@mdcz/server` is the single-port runtime for the browser WebUI. The production build ships a Node server entry, SQLite migrations, and the Vite WebUI static bundle.

## Build And Run

```bash
pnpm build:webui
cd apps/server
node dist/server.js
```

The server listens on `127.0.0.1:3838` by default and serves the WebUI from the same origin. Open `http://127.0.0.1:3838` after startup. Use `pnpm build:server` only when you need the Node server bundle without rebuilding or embedding the WebUI static files.

## Deploy (Docker)

Use the maintained [Compose file](../../compose.yaml) and [deployment guide](../../docker/README.md).
Published images target Linux amd64; CI also checks arm64 builds. The container stores application state in `/data` and uses `/media` for mounted movies.
The guide covers initialization, NAS permissions, health checks, proxying, backups, upgrades and offline recovery.

## Runtime Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port. | `3838` |
| `MDCZ_HOST` | Bind address for the HTTP listener. Set to `0.0.0.0` to expose to the network (the Docker image already does this). | `127.0.0.1` |
| `MDCZ_HOME` | Base directory for server config and data. | Linux: `$XDG_STATE_HOME/mdcz` or `~/.local/state/mdcz`; other platforms: `~/.mdcz` |
| `MDCZ_CONFIG_DIR` | Directory for TOML profiles and the hashed administrator credential. | `$MDCZ_HOME/config` |
| `MDCZ_DATA_DIR` | Directory for server data. | `$MDCZ_HOME/data` |
| `MDCZ_DATABASE_PATH` | SQLite database path. | `$MDCZ_DATA_DIR/mdcz.sqlite` |
| `MDCZ_ADMIN_PASSWORD` | Overrides the persisted single-admin password. Never persisted. | unset |
| `MDCZ_WEB_DIST_DIR` | Static WebUI bundle directory. | `dist/web` in local builds, `/app/web` in Docker |
| `MDCZ_SERVER_BUILD` | Optional build label shown on About. | unset |
| `MDCZ_WEB_BUILD` | Optional Web build label shown on About. | unset |

## Integrations

### Emby deletion sync

Settings → Media servers → Emby → Deletion sync accepts authenticated `library.deleted` webhooks. Start in observation mode, select a move library, and bind the Emby server ID. Emby and MDCz must see the same output path. Notifications are persisted before acknowledgement; cleanup requires two missing-file checks and a valid library identity marker. Other movie versions, task history, downloader deduplication and disk sidecars are retained. See [setup, cleanup scope and rollback](../../docs/emby-deletion-sync.md).

### Library automation

Library automation batches local change events and CloudDrive2 webhooks for up to five seconds. New `.strm` files (case-insensitive) are registered or scraped as soon as a scan discovers them; other videos must keep the same size and modification time across scans for two minutes before processing. Each directory keeps its earliest scan deadline, so repeated events cannot postpone discovery or stability checks. Full rescans catch missing events at the library's configured interval (15 minutes by default); a missed event can therefore add that interval before discovery. The first scan of a newly watched library records existing files as a baseline without submitting them. A download-finished callback to `/api/automation/scrape/start` bypasses the stability wait because the downloader confirms completion.

MDCz takes new files from downloaders and cloud drives in three ways; every one ends in the same scrape path, so overlapping triggers never scrape a file twice.

- **qBittorrent polling.** Settings → Integrations → qBittorrent: the web UI URL, an API key (qBittorrent 5.2+) or a username and password, and a category. Every minute MDCz lists the category's completed torrents and scrapes each `content_path` that finished after polling began. Torrents already finished when you connect are left alone. The category's save path, after path mappings, must lie inside a library's source directory. Files under that save path are never moved: a `move` library hardlinks them, so torrents keep seeding (the output directory must be on the same volume). Keep that folder outside any MoviePilot download folder with downloader monitoring on, or both tools place the same files.
- **CloudDrive2 webhook.** Point CloudDrive2's file system watcher at `POST /api/webhooks/clouddrive`. Settings and the Libraries page show when the last event arrived.
- **`POST /api/automation/scrape/start`** for anything else: download-finished scripts, MoviePilot plugins, cron jobs.

Automation endpoints take an API key created in Settings → Integrations (the WebUI's own session token also works). A key reaches only `/api/automation/*` and `/api/webhooks/*`, never the WebUI.

```bash
Authorization: Bearer <API key>
```

### `POST /api/automation/scrape/start`

Scrapes a file, or every video under a directory, given as the caller sees it. Pass `path` as a query parameter (survives Windows backslashes and spaces) or in a JSON body:

| Field | Required | Meaning |
| --- | --- | --- |
| `path` | yes | Absolute path of the finished file or folder. Path mappings from Settings are applied first, so a downloader in another container can send its own path. |
| `libraryId` | no | Scrape into this library. By default the library whose source directory holds `path` is used. |

```bash
curl -fsS -X POST -G -H "Authorization: Bearer $MDCZ_KEY"   --data-urlencode "path=/downloads/jav/ABC-123"   http://mdcz:3838/api/automation/scrape/start
```

The response is `{ "task": …, "webhook": …, "duplicate": false }`. A path the library already holds, or one whose scrape is still running, queues nothing and answers `{ "task": null, "webhook": null, "duplicate": true }`, so repeated calls are safe. A path outside every library, or a folder with no videos, is an error naming the path.

### Other endpoints

- `GET /api/automation/library/recent?limit=20` returns recent tasks in the webhook payload shape.
- `GET /api/automation/webhooks/status` returns outbound webhook delivery counts and the last error.

### Outbound webhook

Set the webhook URL and secret in Settings → Integrations → Notifications. MDCz posts this JSON when a task first starts running and when it first ends (`completed`, `failed`, `stopped` or `interrupted`), with the secret in `x-mdcz-webhook-secret`:

```json
{
  "taskId": "task-id",
  "kind": "scrape",
  "status": "completed",
  "startedAt": "2026-05-01T00:00:00.000Z",
  "completedAt": "2026-05-01T00:01:00.000Z",
  "summary": "Scrape Media: completed",
  "errors": []
}
```

Deliveries run through one in-process queue with a 10-second timeout. They are best-effort: nothing is persisted, retried or replayed after a restart. Use `GET /api/automation/library/recent` to reconcile.

## Reverse Proxy

Terminate TLS at the proxy and forward one origin to the Node server:

```nginx
location / {
  proxy_pass http://127.0.0.1:3838;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

For task updates, keep SSE buffering disabled:

```nginx
location /events/tasks {
  proxy_pass http://127.0.0.1:3838;
  proxy_buffering off;
  proxy_set_header Connection "";
}
```
