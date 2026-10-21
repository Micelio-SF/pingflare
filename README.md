# Pingflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Micelio-SF/pingflare)

Self-hosted uptime monitoring that runs entirely on Cloudflare's edge network. No servers to maintain, no infrastructure to manage — just click deploy.

![Dashboard](./docs/dashboard.png)

## Why Pingflare?

- **Truly self-hosted** — All data stays in your Cloudflare account. No external dependencies.
- **Zero infrastructure** — Runs on Cloudflare Workers + D1. No VMs, no containers, no maintenance.
- **Global monitoring** — Health checks run from Cloudflare's edge, giving you real external monitoring.
- **Free tier friendly** — Works within Cloudflare's free tier for up to ~25 monitors.

## Features

### Health Checks

Build sophisticated monitoring without writing code:

- **Multi-step scripts** — Chain requests with variable extraction (login → get token → check API)
- **Visual builder** — Point-and-click health check configuration
- **Flexible assertions** — Validate status codes, response times, JSON paths, headers
- **Severity levels** — Mark services as degraded or down based on different conditions

![Script Builder](./docs/edit-monitor.png)

### Status Pages

Share your service status with users:

- **Public status pages** — Shareable URL at `/status`
- **Monitor groups** — Organize services logically (API, Web, Database)
- **90-day history** — Visual uptime bars showing daily status
- **Incident management** — Create incidents, post updates, track resolution

![Status Page](./docs/status-page.png)

### Notifications

Get alerted when things break:

- **Multiple channels** — Slack, Discord, webhooks, and browser push
- **PWA support** — Install Pingflare on your phone and receive native push notifications
- **Per-monitor config** — Choose which alerts go where

![Notifications](./docs/notifications.png)

### Security

- **Session-based auth** — Secure login with email/password
- **Role-based access** — Admin, Editor, and Viewer roles
- **Protected APIs** — All admin endpoints require authentication
- **Secure manual checks** — The HTTP cron endpoint requires a secret; scheduled checks have no public endpoint
- **Your infrastructure** — Data never leaves your Cloudflare account

## Quick Start

### Micelio defaults

Fresh deployments apply `migrations/0002_micelio_status.sql` and the seed migrations that follow it, creating two public groups and seven active one-minute monitors:

- **Micelio:** `https://api.micelio.ai/`, `https://api.micelio.ai/api/db-health`, and `https://micelio.ai/`
- **External dependencies:** the SII landing page, a `HEAD` request to OpenRouter's public models endpoint, Gemini's unauthenticated models endpoint, and OpenRouter's published provider status for Gemini

The OpenRouter and Gemini checks do not invoke a model, consume tokens, or require API keys. Gemini intentionally expects the API gateway's `403 PERMISSION_DENIED` response for an anonymous request. This verifies DNS, TLS, routing, and the Gemini API gateway without billable inference.

Micelio's PostgreSQL database is monitored through `GET /api/db-health` on the public API, which runs a bounded `SELECT 1` and returns `{"database":"up"}` with no infrastructure details. No database credentials are shared with Pingflare. The endpoint is rate limited to one request per thirty seconds per client, so the monitor's one-minute interval stays well inside the limit.

### One-Click Deploy

1. Click the **Deploy to Cloudflare** button above
2. Authorize Cloudflare to access your GitHub
3. Click Deploy — Cloudflare handles the rest
4. Set the cron secret (required for manual HTTP health checks):
5. Deploy the three check Workers using the commands below; the main Worker only schedules daily maintenance.
6. Visit your Worker URL and create an admin account

### Manual Setup

```bash
git clone https://github.com/Micelio-SF/pingflare.git
cd pingflare
bun install
wrangler login
wrangler d1 create pingflare-db
# Update wrangler.toml with your database ID
bun run build
wrangler d1 migrations apply DB --remote
bun run deploy:checks
wrangler deploy

# Set the cron secret (required for manual HTTP health checks)
openssl rand -hex 32 | wrangler secret put CRON_SECRET
```

## Local Development

```bash
bun install
bun run dev      # Start dev server at localhost:5173
bun test         # Run tests
bun run check    # Type checking
```

## Limitations

- **~25 monitors** — Cloudflare's 50 subrequest limit per cron invocation
- **1-minute intervals** — Minimum check frequency (Cloudflare cron limitation)
- **Free tier** — 100k requests/day, 10ms CPU/request

## Contributing

Contributions welcome! Feel free to open issues and pull requests.

## License

MIT

### Worker diagnostics

Workers Logs and invocation logs are enabled in `wrangler.toml`. Deploy the updated
configuration to start collecting them in Cloudflare Observability. Filter custom
logs by `event`: `request_completed`, `request_failed`, `scheduled_started`,
`scheduled_completed`, `scheduled_failed`, `monitor_completed`, `monitor_failed`,
or `cron_completed`. Correlate monitor entries using `run_id` and `monitor_id`.
`duration_ms` is elapsed time, including network waits; use Cloudflare invocation
CPU metrics to investigate CPU limits. Request logs omit query strings, headers,
credentials and response bodies.

The public overview is `/`, sign-in is `/login`, and the protected dashboard is
`/dashboard`. `/status` redirects to `/`; group pages retain `/status/:slug`.
Health check responses needed by assertions or extraction are limited to 1 MiB.
Status-only checks cancel the body without downloading or parsing it.

The database monitor requires `https://api.micelio.ai/api/db-health` to return
HTTP 200 with `{"database":"up"}`. This endpoint belongs to the Micelio backend;
adding the monitor migration does not create the probe.

### Independent check invocations

`wrangler.checks.toml` defines three cron-only Workers (`pingflare-checks-0/1/2`),
all bound to the same D1 database. Every minute each Worker selects its partition
from active monitors sorted by ID (position modulo three). Seven monitors therefore
run as groups of three, two and two, each in a separate scheduled invocation.
Deploy all three environments with the same shard count and code version. Update
the database IDs in both existing Wrangler configs and all three check environments
when using another database. These Workers need no `CRON_SECRET` or HTTP route.

The main `pingflare` Worker runs aggregation and retention cleanup at 00:00 UTC,
separately from health checks. Deploy all three check Workers before updating the
main Worker; otherwise removing its minute cron would stop some or all checks.
During an upgrade from the original single cron there can be brief overlap until
the old schedule is removed. Cloudflare cron changes can take several minutes to
propagate, so verify each check Worker's invocation logs and each monitor's latest
check after deployment. `bun run deploy` applies migrations and deploys all three check Workers before the main Worker.
Rollback requires restoring the previous main Worker AND removing the three new
minute schedules, to avoid duplicated checks.

Latest results are loaded with the monitors in one indexed query per partition.
Positive `body contains` assertions stop reading once all required strings are
found; JSON, extraction and other body assertions retain bounded full-body reads.
A positive match measures response time up to that match rather than the remaining
body download. Missing text still reads to EOF or the existing 1 MiB limit.
`GET /api/cron` remains a secret-protected manual run of the full monitor set.

Workers Builds injects `WRANGLER_CI_OVERRIDE_NAME` and `WRANGLER_CI_MATCH_TAG`
for the connected main Worker. `deploy:checks` removes these two targeting values
only from each shard deployment subprocess, allowing its explicit Wrangler
configuration to select `pingflare-checks-0/1/2`. Authentication and account values
remain inherited. The final main deployment retains both CI targeting values.
Do not replace `bun run deploy:checks` with bare shard deploy commands inside a
connected build: Wrangler would override their names with the main Worker name.
