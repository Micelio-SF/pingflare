Tooling

- Stack: SvelteKit 2, Svelte 5, TypeScript, Tailwind CSS 4
- Package manager: bun
- Test command: bun test (bun:test)
- Lint command: bun lint
- Format command: bun format
- Check command: bun check
- PWA support: @vite-pwa/sveltekit

Branding

- Public product name: Micelio Status
- Canonical logo source: ../micelio/frontend/public/logo.svg
- Brand colors: navy #1E3A5F, mint #74C69D, overlap #45797B
- User-facing status and dependency copy is English; preserve external service names and literal response assertions such as SII content

Build & Deploy

- Build: bun run build (SvelteKit + custom worker bundling via esbuild)
- Deploy: bun run deploy (applies D1 migrations + wrangler deploy)
- Output directory: dist/ (static assets + _worker.js)
- Cron: Integrated scheduled() handler, runs every minute
- Deploy button: One-click deployment from GitHub supported

Project Context

- Name: pingflare - Cloudflare-native uptime monitoring solution
- Goal: Monitor ~30 services on Hetzner dedicated server from external Cloudflare infrastructure
- Inspiration: Uptime Kuma but serverless on Cloudflare ecosystem
- Deployed at: https://pingflare.pages.dev
- Current state: MVP complete with HTTP/Script monitoring, dashboard, authentication

Cloudflare Resources

- D1 Database: pingflare-db (binding: DB)
- Workers Project: pingflare (with Static Assets)
- ASSETS binding: Fetcher for static file serving

Directory Structure

- src/lib/components/ - Svelte components (MonitorCard, MonitorForm, ScriptBuilder, ScriptEditor, NotificationChannelCard, NotificationChannelForm, etc.)
- src/lib/components/ui/ - UI primitives (Button, Input, Select, Textarea, Card, Alert, Badge, Spinner, IconButton)
- src/lib/components/layout/ - Layout components (AppShell, Header, BottomNav, PageHeader, Container)
- src/lib/utils/ - Utility functions (format.ts)
- src/lib/server/checkers/ - Health check implementations (script.ts executor, index.ts orchestrator)
- src/lib/server/db/ - Database operations (monitors.ts, auth.ts, notifications.ts)
- src/lib/server/notifications/ - Notification senders (slack.ts, discord.ts, webhook.ts, webpush.ts, index.ts)
- src/lib/types/ - TypeScript interfaces (monitor.ts, auth.ts, script.ts, notification.ts)
- src/routes/ - SvelteKit pages (dashboard, /login, /setup, /settings, /monitors/new, /monitors/[id]/edit, /notifications)
- src/routes/api/ - REST API endpoints
- src/hooks.server.ts - Auth middleware, route protection
- src/worker.ts - Custom worker entry (not used directly, template for build)
- scripts/build-worker.js - Post-build worker bundling script
- migrations/ - D1 SQL migration (single consolidated file: 0001_schema.sql)

Database Schema

- monitor_groups: id, name, slug, description, is_public, display_order, created_at
- monitors: id, name, group_id (FK), interval_seconds, timeout_ms, active, script (JSON DSL), created_at, updated_at
- checks: id, monitor_id (FK), status, response_time_ms, status_code, error_message, checked_at, checked_from
- incidents: id, title, status, group_id (FK), created_at, resolved_at
- incident_updates: id, incident_id (FK), status, message, created_at
- daily_status: monitor_id, date, total_checks, up_checks, down_checks, degraded_checks, downtime_minutes
- notification_channels: id, type (webhook/slack/discord/webpush), name, config (JSON), active, created_at
- monitor_notifications: monitor_id, channel_id, notify_on (CSV), downtime_threshold_s (junction table)
- push_subscriptions: id, endpoint (unique), p256dh, auth, user_agent, created_at
- users: id, name, email (unique), password_hash, role, created_at, updated_at, last_login_at
- sessions: id, user_id (FK), expires_at, created_at
- app_settings: key, value, updated_at

API Endpoints

- GET/POST /api/monitors - List/create monitors
- GET/PUT/DELETE /api/monitors/[id] - Single monitor CRUD
- GET /api/cron - Trigger health checks (manual or cron)
- GET /api/status - Status endpoint (public, queries D1 directly)
- GET/POST /api/groups - List/create monitor groups
- GET/PUT/DELETE /api/groups/[id] - Single group CRUD
- GET/POST /api/incidents - List/create incidents (requires group_id)
- GET/POST/DELETE /api/incidents/[id] - Single incident operations
- GET /api/auth/status - Check setup state and current user
- POST /api/auth/setup - Create initial admin (name, email, password)
- POST /api/auth/login - Email/password authentication
- POST /api/auth/logout - Delete session
- PUT /api/auth/profile - Update user name
- PUT /api/auth/password - Change password
- GET/POST /api/notification-channels - List/create notification channels
- GET/PUT/DELETE /api/notification-channels/[id] - Single channel CRUD
- POST /api/notification-channels/[id]/test - Send test notification
- GET /api/push/vapid-key - Get VAPID public key for browser subscription
- POST/DELETE /api/push/subscribe - Manage push subscriptions
- GET /api/monitors/[id]/notifications - Get monitor's notification subscriptions

Authentication

- Session-based auth with cookies (7-day expiry)
- SHA-256 password hashing via Web Crypto API
- User fields: name, email (login), password
- Role-based permissions: admin/editor/viewer (defined in src/lib/types/auth.ts)
- First visit redirects to /setup, subsequent visits to /login
- Settings page at /settings for profile and password management
- API auth pattern: each handler checks `if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 })`
- Public API: /api/public/*, /api/auth/*
- Protected API: all other endpoints require authenticated session
- /api/cron: requires CRON_SECRET env var, validates X-Cron-Secret header (internal scheduled handler only)
- /api/status: requires auth (returns all monitors, use /api/public/status for public data)
- CRON_SECRET: required secret for cron, set via `wrangler secret put CRON_SECRET`

Monitor Types

- All monitors use JSON DSL script format (no separate http/tcp types)
- tcp/dns: Planned (schema exists)
- push: Passive monitors (different flow)

Script Checker (JSON DSL)

- All monitors use JSON-based DSL for health checks
- UI: Visual Builder (ScriptBuilder.svelte) or Code mode (ScriptEditor.svelte) with toggle
- Supports chained requests: GET, POST, PUT, DELETE, PATCH, HEAD
- Variable extraction: "extract": { "token": "json.access_token" }
- Variable interpolation: ${varName} in URLs, headers, body
- Assertions: equals, notEquals, contains, notContains, matches (regex), greaterThan, lessThan, greaterOrEqual, lessOrEqual, minLength, maxLength, hasLength, hasKey, exists
- Assertion severity: each assertion has optional "severity": "degraded" | "down" (default: degraded)
- Path notation: json.user.name, json.items[0].id, status, responseTime, body, headers.content-type
- responseTime: per-step response time in ms, use for performance assertions (e.g., { "check": "responseTime", "lessThan": 500 })
- Status determination: request fails = down, assertion with severity=down fails = down, assertion with severity=degraded fails = degraded, all pass = up
- Validation function: validateScript() in src/lib/server/checkers/script.ts
- Shared types: src/lib/types/script.ts (ScriptDSL, ScriptStep, Assertion, AssertionSeverity, HttpMethod)

Scheduler (Integrated)

- Cron handler integrated in main Worker (scheduled() export)
- Triggers /api/cron internally every minute via cron trigger
- Configured in wrangler.toml [triggers] section
- No separate deployment needed

Svelte 5 Patterns

- $state() for reactive state variables
- $derived() for computed values (e.g., upCount, downCount)
- $effect() for side effects (auto-refresh, cleanup)
- $props() for component props with destructuring
- Snippet type for component children (Modal)
- @render for rendering snippets

Coding Patterns

- Checker orchestrator: src/lib/server/checkers/index.ts routes by monitor type
- Dependency injection: db passed to all functions (testable)
- Promise.allSettled() for parallel checks (tolerates individual failures)
- DTO pattern: userToPublic() removes password_hash
- Dynamic SQL in updateMonitor() for partial updates

Future Cloudflare Products

- Durable Objects: Real-time WebSocket for live updates (Phase 2)
- Queues: Async notification processing (Phase 2)

Architectural Constraints

- Cron triggers max 25 monitors due to 50 subrequest limit per invocation
- Cloudflare Workers blocks eval/new Function (script checker uses JSON DSL, not JS eval)
- Workers can make outbound TCP connections via connect() API from cloudflare:sockets
- Free tier: 100k requests/day, 10ms CPU/request

UI Component Library

- Button: variants (primary/secondary/danger/ghost), sizes (sm/md/lg), loading state, href support
- Input: types (text/email/password/number/url), label, error, helper text
- Select: dropdown with label and error
- Textarea: with label, error, monospace option
- Card: container with optional header/footer snippets, padding sizes
- Alert: variants (error/success/warning/info), dismissible
- Badge: status indicators, maps MonitorStatus to colors
- Spinner: loading indicator, sizes (sm/md/lg)
- IconButton: icons (edit/delete/add/chevron-up/chevron-down/close/back/menu/check/refresh)

Layout Components

- AppShell: combines Header (desktop) + content + BottomNav (mobile)
- Header: desktop header with logo, nav links, user menu, logout
- BottomNav: fixed bottom nav for mobile with 4 items (Dashboard/Add/Alerts/Settings)
- PageHeader: title, optional subtitle, back button, actions snippet
- Container: max-width wrapper with sizes (sm/md/lg/xl/full)

Not Yet Implemented

- Email and Telegram notification channels
- TCP/DNS checkers (scaffolded)
- Downtime threshold enforcement per channel (schema ready, cron not fully integrated)
- Micelio database health monitoring requires a public, bounded backend probe; never expose database credentials to Pingflare

Micelio Status

- Public website: https://micelio.ai/
- Public API health response: https://api.micelio.ai/ returns {"status":"public"}
- External checks avoid billable inference: OpenRouter uses HEAD /api/v1/models; Gemini expects anonymous 403 PERMISSION_DENIED
- Gemini-through-OpenRouter is checked via the anonymous GET /api/v1/models/google/gemini-2.5-flash/endpoints; OpenRouter publishes per-provider status (0 is healthy, negative is deranked) plus uptime_last_5m/30m and latency, so no key or inference is needed
- A true end-to-end OpenRouter inference check needs ${env.SECRET} interpolation in the DSL first; monitor scripts are stored as plaintext in D1 and shown in the admin UI
- The database is probed through https://api.micelio.ai/api/db-health, an unauthenticated public API route that runs SELECT 1 and returns {"database":"up"}, rate limited to one request per thirty seconds per client IP
- Seed configuration lives in migrations/0002_micelio_status.sql and is covered by migrations/micelio-status.test.ts

Auth

- Password hashes are self-describing: pbkdf2$iterations$saltB64$digestB64, hashed in src/lib/server/crypto.ts; bare 64-hex values are legacy SHA-256 and are rewritten to PBKDF2 on the next successful login
- Login rate limiting lives in the login_attempts table, keyed by lowercased email, ten failures per fifteen minutes
- Secrets and password hashes are compared with timingSafeEqual, never with ===

User Preferences

- Never include "Claude" or "Claude Code" or co author tags in any git commit messages.

- Public overview now lives at /; /status redirects to /; authenticated dashboard is /dashboard, with sign-in at /login. Public status requests bypass setup/session queries.
- Runtime Worker entry is generated by scripts/build-worker.js; src/worker.ts is an unused template. Observability logs and invocation logs are enabled in both Wrangler configs.
- Monitor bodies are read only for body/JSON assertions or extraction, capped at 1 MiB; network timeout includes body reads. Cron respects interval_seconds and emits monitor/run IDs with elapsed duration (not CPU time).
- Database monitor branch builds and all six migrations apply locally; api.micelio.ai/api/db-health returned HTTP 404 during verification. Cloudflare failed build details require dashboard login.

- Canonical local checkout: /home/victor/Documentos/Coding/micelio-status, sibling of /home/victor/Documentos/Coding/micelio. Backend probe added in micelio/backend/app/api/endpoints/public/health.py; SELECT 1, read-only connection, 3s connect / 2s statement timeouts, existing Redis rate limiter (30s), 200/503 database up/down. Requires backend deployment.

- Production pingflare-db ID confirmed by user: aae83e5f-a3a7-4b2c-9f2a-051c5db95dfd. Both Wrangler configs must agree; previous ID caused Cloudflare error 10181.

- Public overview uses getPublicGroupSummaries: three bulk queries plus two incident queries, without daily_status payloads. Group detail uses 4+M queries including incidents, independent of incident/update counts.
- history.ts combines authoritative daily_status with raw checks for unaggregated days over 90 UTC calendar dates; Missing dates are enumerated before indexed raw-check range reads; existing aggregate days are skipped before scanning. Overview/detail share counts; deleted raw history remains represented through aggregates. No migration required.
- Public status D1 diagnostics: d1_query_completed/failed with named operation, request_id, elapsed/SQL duration and row counts; no SQL, bindings or payloads. status_data_completed correlates the page load; durations are not Worker CPU. UptimeBars reuses one UTC Intl formatter.

- Public response caching uses named Cache API storage micelio-public-status-v1, never caches.default: the Cloudflare adapter reads default before hooks and would bypass Cookie/Accept checks. Internal copies expire after 60s; outward responses are private,no-store to prevent adapter/CDN recaching. Only anonymous parameterless GET public HTML and /api/public/status qualify; errors/session responses stay live.
- Unmatched SvelteKit event.route.id resolves directly before setup/session reads, preserving framework 404s for scanner paths.

- CPU investigation: seven seeded monitors replayed in workerd/Miniflare with isolated in-memory D1, no channels, interval_seconds=0, 10 warmups + 100 runs/scenario; CDP non-idle sample estimates (not Cloudflare CPU accounting): full cron ~7.0–7.4 ms, status-only ~5.6–5.7, no HTML monitors ~4.2, direct route without SvelteKit ~6.4. Node checker-only ~0.33 ms is not representative of full Worker. Current captured HTML: Micelio 113608 bytes, SII 61925; OpenRouter Gemini JSON 4076. Fixtures from fetch are decoded: remove content-encoding/content-length when replaying or profiles become invalid. Harness/profiles: /tmp/micelio-status-cpu (temporary). Remote Wrangler auth invalid_grant; production logs/config not verified.

- Cron CPU implementation: wrangler.checks.toml deploys three cron-only Workers (shard-0/1/2, shared D1, sorted active IDs modulo 3); main Worker schedules only 00:00 UTC maintenance. package deploy applies migrations, deploys all three check environments, then main. Scheduler calls shared cron.ts directly; HTTP /api/cron remains secret-protected full manual run. Latest checks loaded in one indexed query (timestamp/id tie); no per-monitor latest query. Positive body-only contains assertions cancel early after all matches; all other body consumers retain bounded full reads. Exclude _scheduler.js from static assets via generated .assetsignore.
- Controlled scheduled replay stages: original ~6.49 ms, bulk latest ~5.43, plus early body matching ~4.62, direct scheduler ~4.36 for all seven; final separate partitions ~2.72/2.20/2.20 per invocation. CDP sample estimates, no notification channels, production unverified; scripts/profiles/results-stages.json remain temporary in /tmp/micelio-status-cpu.
