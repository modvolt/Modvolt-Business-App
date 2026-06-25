---
name: Modvolt Knowledge operational gotchas
description: Non-obvious runtime/test failure modes for the standalone RAG app (crash-on-rejection, schema drift, S3 endpoint scheme, local auth testing).
---

## Unhandled DB/IO rejections crash the whole server
The Express route handlers (e.g. `/api/search`, `/api/ask`) `await` DB/IO calls WITHOUT try/catch, so any rejected promise becomes a Node `unhandledRejection` and kills the entire server process (not a 500). `tsx watch` will NOT restart it until a source file changes, so the app just goes dark.
**Why:** During live e2e, a single bad query took the whole server down; root cause was schema drift (below), but the crash surfaced as `fetch failed`/`ECONNREFUSED`, masking the real DB error.
**How to apply:** When debugging a server that dies on one request, reproduce the failing operation in isolation via `tsx` (import the service/query directly) to see the real stack — the HTTP path hides it. Wrapping handlers / adding a global handler is a worthwhile hardening follow-up.

## Schema drift = hard crash; migrations now auto-apply on startup
Drizzle migrations live in `modvolt-knowledge/drizzle/`. A missing column (e.g. `search_queries.csn_lock_*`) makes the insert throw → unhandledRejection → server crash.
**Why:** The `search_queries` table was once 2 migrations behind; every `/search` and `/ask` insert crashed the process. Migrations only ran via manual `npm run db:migrate`, so a Docker/Coolify deploy could ship code against an out-of-date DB.
**How to apply:** `server/index.ts` now calls `runMigrations()` (exported from `db/migrate.ts`) after `validateEnv()` and BEFORE `app.listen` — pending migrations apply on every boot; failure throws → `process.exit(1)` (loud fail, no serving a broken schema). `runMigrations()` is idempotent (pgvector + migrate + seedDefaults). The CLI `npm run db:migrate` now runs `db/migrate-cli.ts` (thin wrapper). NOTE: `migrate.ts` resolves the `drizzle/` folder via existence-checked candidates (`findMigrationsFolder`) because esbuild bundles `index.ts` into `dist/server/index.js`, shifting `import.meta.url` depth — a single `__dirname`-relative path breaks in the bundle.

## S3_ENDPOINT must include a scheme
The AWS SDK throws `TypeError: Invalid URL` for endpoints without `http(s)://` (e.g. Hetzner `fsn1.your-objectstorage.com`). `env.ts` now normalizes via `normalizeEndpoint()` (prepends `https://`). HeadBucket/Put/Get/List/Delete all work against Hetzner with `forcePathStyle=true`.
**Why:** User-provided `S3_ENDPOINT` had no scheme; every S3 call (incl. `checkS3Health`) failed, so `s3Reachable` was false despite valid creds.
**How to apply:** Keep the scheme-normalization; don't assume users include `https://`.

## Local HTTP auth testing needs X-Forwarded-Proto: https
Session cookie is `Secure` + `SameSite=None` with `trust proxy=1`. Over plain `http://localhost`, express-session refuses to set/accept the cookie, so every authed request 401s. Send header `x-forwarded-proto: https` on every request to make the connection count as secure. Health route is `/health` (mounted at root), NOT `/api/health`.
**Why:** First e2e attempt 401'd on all authed routes until the forwarded-proto header was added.
**How to apply:** Any script/curl hitting authed endpoints locally must send `x-forwarded-proto: https`. A reusable live test lives at `modvolt-knowledge/scripts/e2e-live-test.mjs`.

## CRITICAL: Replit bakes its internal proxy URL into package-lock.json
Replit's npm runs through an internal package firewall (`http://package-firewall.replit.local/npm/...`). Every package installed or updated inside Replit gets this URL written into `package-lock.json` as the `"resolved"` field. Outside Replit (Hetzner Docker build), these URLs return ENOTFOUND → npm fails with "Exit handler never called!" after exhausting retries.
**Why:** 541 packages in the lockfile had `package-firewall.replit.local` URLs. Adding `express-rate-limit` + `helmet` in Replit caused those packages (and their transitive deps) to be written with proxy URLs, breaking the Docker build.
**How to apply:** The Dockerfile now has a `sed` step immediately after `COPY package.json package-lock.json* ./`:
```dockerfile
RUN if [ -f package-lock.json ]; then \
      sed -i 's|http://package-firewall\.replit\.local/npm/|https://registry.npmjs.org/|g' package-lock.json; \
    fi
```
This rewrites all proxy URLs to real registry.npmjs.org URLs. npm ci integrity hashes (sha512) stay valid — they verify downloaded content, not the URL. This step must run BEFORE any `npm ci` call. **Any future npm install/update in Replit will re-introduce proxy URLs for new/updated packages — the Dockerfile sed step handles them all automatically.**

## Coolify compose mode can't do nested ${VAR} interpolation
Coolify's "Docker Compose" build pack does NOT reliably expand a UI-set variable embedded inside a longer string (e.g. `DATABASE_URL: postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/modvolt`). The result is an empty `DATABASE_URL` → app throws "DATABASE_URL není nastaveno" at db/index.ts module-init. Simple pass-through (`KEY: ${KEY}`) of UI vars works; embedded/composed interpolation does not.
**Why:** Repeated deploy failures: setting `POSTGRES_PASSWORD` in the UI never reached the app because the compose `environment:` used it inside the DATABASE_URL string.
**How to apply:** For the local-only DB (no exposed `ports:`, reachable only inside the Docker network), hardcode `DATABASE_URL` and `POSTGRES_PASSWORD` as literals in `docker-compose.yml` (same value on both `app` and `db`). Also note: `EAI_AGAIN db` means the `db` service isn't running — its DB hostname can't resolve.

## Coolify does NOT auto-inject UI env vars — enumerate every var in compose
Setting a variable in the Coolify UI does NOT make it reach the container. In compose mode the var only arrives if the service's `environment:` lists it as an explicit pass-through `KEY: ${KEY}` (or `${KEY:-}` to silence unset-warnings). So the compose `environment:` block must enumerate the FULL app env surface (SESSION_SECRET, APP_BASE_URL, S3_*, OPENAI_* = OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_ENABLED/OPENAI_CHAT_MODEL/OPENAI_EMBEDDING_MODEL/limits, WEB_SEARCH_*, ADMIN_*, image/upload limits, NODE_ENV, LOG_LEVEL). DATABASE_URL stays a hardcoded literal (nested interpolation is what breaks).
**Why:** Newly added env vars (per-model OpenAI keys) silently never reached the deployed container because the root compose only listed PORT + DATABASE_URL; the assumption that "Coolify injects UI vars automatically" was wrong.
**How to apply:** Whenever you add a new env var to the app, you MUST also add `NEW_VAR: ${NEW_VAR:-}` to BOTH compose files' `app.environment` (keep root `/docker-compose.yml` and `modvolt-knowledge/docker-compose.yml` in sync). Validate with `docker compose -f <file> config -q`.

## CRITICAL: TWO compose files exist — Coolify reads the ROOT one
There are two compose files: `/docker-compose.yml` (repo root) and `/modvolt-knowledge/docker-compose.yml`. **Coolify is configured Base Directory=`/`, Compose Location=`/docker-compose.yml`, so it reads ONLY the root file.** The root file builds the app via `build.context: ./modvolt-knowledge` (the app lives in that subdir). The subdir compose is for standalone/portable local runs and is NOT used by the deploy.
**Why:** Hours were lost editing the subdir compose while Coolify kept reading the stale root compose (which had `db` behind a `with-db` profile so it never started, and never set `DATABASE_URL`). Same error persisted no matter what the subdir file said.
**How to apply:** For any Coolify/deploy change, edit the ROOT `/docker-compose.yml`. The `db` service there must have NO `profiles:` (so it starts by default). Keep both files in sync if you must keep both; better, treat the root file as the single source of truth for deployment.

## Admin user is seeded at startup (create-if-missing), not by seedDefaults
`seedDefaults()` only seeds categories + app_settings — it does NOT create the admin user. The admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` is created by `seedAdmin(db)`, now called inside `runMigrations()` after `seedDefaults()` on every boot. Without this, a fresh deploy has zero users and every login returns 401 even with correct env credentials.
**Why:** On Coolify the standalone `db:seed-admin` CLI never runs, so the DB had no admin → login always failed. Login is checked against the DB (bcrypt), not against env directly.
**How to apply:** `seedAdmin(db)` (shared fn in `db/seed-admin.ts`) is create-if-missing by default — it does NOT overwrite an existing admin's password on restart (so in-app password changes survive). The CLI `npm run db:seed-admin` (`db/seed-admin-cli.ts`) calls `seedAdmin(db, { force: true })` to force-reset the admin to env values. To rotate the admin password via env, either run the CLI in the container or temporarily change the email (new email → new create).

## OpenAI calls from self-hosted server must be retried (transient "Premature close")
On the Hetzner/Coolify deployment, indexing failed with `FetchError: ... /v1/embeddings: Premature close` — a transient network drop between the server and api.openai.com (node-fetch closing the response stream mid-read). The indexing worker had NO retry, so a single blip permanently marked the document `failed`.
**Why:** Self-hosted egress to OpenAI is less reliable than Replit's; large embedding batches (was 64 chunks → big response body) raise the chance of a mid-stream close. The OpenAI SDK's built-in retry does NOT reliably cover response-body read errors, so a wrapper-level retry is required.
**How to apply:** Wrap OpenAI calls (esp. embeddings) in retry-with-exponential-backoff that treats network/`Premature close`/`ECONNRESET`/429/5xx as retryable but NOT 4xx config errors. Keep `maxRetries` on the client too. Prefer smaller embedding batches (default lowered to 16, env `OPENAI_EMBEDDING_BATCH_SIZE`); retries via env `OPENAI_MAX_RETRIES`. If a doc still lands `failed` after a sustained outage, the admin UI "Reindex" re-queues it.

## OpenAI: ONE key + ONE client + optional base URL (single-model design)
The AI layer uses a single `OPENAI_API_KEY` and one shared client for all roles. Chat, classification AND vision all run on the one `chatModel` (must be multimodal for image analysis). Embeddings still require a SEPARATE `embeddingModel` — a chat model cannot produce embeddings, so literal "one model for everything" is impossible; the closest is one key + one chat model + one embedding model.
**Why:** Per-model keys add operational confusion with no benefit on standard OpenAI; one key + base-URL override covers both OpenAI and any compatible reseller. Embeddings vs chat are different model types and cannot be collapsed into one model.
**How to apply:** Config = `env.openai.{apiKey, baseUrl, chatModel, embeddingModel}`. `OPENAI_BASE_URL` (empty = api.openai.com, normalized via `normalizeEndpoint`) points at any OpenAI-compatible provider WITHOUT code changes — add this first if switching providers. `getOpenAi()` takes NO args (single cached client). `isOpenAiUsable() = enabled && apiKey`; `isChatUsable`/`isEmbeddingsUsable` alias it; `isVisionUsable` also needs `imageAnalysisEnabled`. If AI "doesn't work" on plain OpenAI, suspect (in order): (1) INVALID MODEL VALUE — the Coolify deploy has repeatedly used non-existent IDs like `gpt5.5`/`GPT-5.5` for `OPENAI_CHAT_MODEL` (and even put a model name in the boolean `OPENAI_IMAGE_ANALYSIS_ENABLED`); OpenAI IDs are exact lowercase-with-hyphens (`gpt-4o-mini`). A bad chat model 404s → chat path throws; `ask()` now wraps the completion call and maps OpenAI errors to a clear 503 (`describeOpenAiError`: 401/403=key, 404=model, 429=credit). (2) ENV DELIVERY (OPENAI_ENABLED/OPENAI_API_KEY not reaching the container — see Coolify pass-through note) or `OPENAI_ENABLED` defaulting false. NOT the two-compose setup (verified: root compose enumerates all app env vars, in sync with subdir). Embeddings use a DIFFERENT model (`text-embedding-3-small`) so a bad CHAT model breaks chat but NOT indexing.

## Upload filenames with diacritics arrive mojibake — re-decode latin1→utf8
Czech filenames came out garbled in the document list ("Modulární" → "ModulÃ¡rnÃ­"). Cause: multer/busboy decodes the multipart filename header as **latin1**, so UTF-8 bytes get misread. Fix: a middleware runs after each multer middleware and rewrites `req.file(s).originalname` via `Buffer.from(name,"latin1").toString("utf8")` (identity for pure ASCII).
**Why:** The S3 object key is a content hash (ASCII-safe), so storage was never affected — only the human-readable `title`/`originalFileName` stored in the DB. Verified: the exact screenshot mojibake round-trips back to the correct string.
**How to apply:** Apply the latin1→utf8 re-decode ONLY to multipart filenames. Do NOT apply it to ZIP entry names — those come from adm-zip (`entry.entryName`), which already attempts UTF-8; re-decoding would corrupt them. ZIP-internal name encoding (Windows CP1250/CP852 archives) remains a known unfixed edge case. The fix only affects NEW uploads; documents already stored with mangled titles must be re-uploaded (reindex re-processes content, not the title).

## Docker build itself is clean — `npm ci` failures are server-side
The Dockerfile `npm ci` reproduces successfully inside the exact `node:24-slim` base. So when Coolify/Hetzner deploys fail at `npm ci`, suspect: (1) Replit proxy URLs in lockfile [see above], (2) ENOSPC disk full on Hetzner, (3) npm registry unreachable. The install step dumps npm debug-log + `df -h` on failure. Base must stay `node:24-slim` (npm 11); `node:22-slim` ships npm 10.9.8 with a genuine "Exit handler never called!" bug. No build toolchain needed (no `apt-get python3 make g++`).

## Express route order: static paths MUST precede `/:id`
`documentRouter` matches in registration order. A new static route like
`GET /documents/queue-status` registered AFTER `GET /documents/:id` is silently
captured by `:id` (treated as a document id) and never runs. Register all static
sub-paths (`/queue-status`, `/batch/*`, etc.) BEFORE the `:id` param route.
**Why:** the bulk-import queue-status endpoint initially sat below `/:id` and
client polling got a 404/doc-lookup instead of queue data.
**How to apply:** when adding any `GET /documents/<word>` route, place it above
the `/:id` handler (or constrain `:id` to a UUID pattern).

## Testing AI citations must avoid the ČSN lock
A query containing norm keywords (`proudový chránič`, `RCD`, …) forces `csn_only` mode, which filters retrieval to norm/standard document types. An `internal_procedure` test doc is then excluded → 0 chunks → ungrounded fallback answer (correct behavior, not a bug).
**How to apply:** To prove the citation-grounding happy path, use a non-norm query against the uploaded doc's unique content (e.g. a magic constant string).
