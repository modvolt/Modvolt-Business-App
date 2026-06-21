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
**How to apply:** For the local-only DB (no exposed `ports:`, reachable only inside the Docker network), hardcode `DATABASE_URL` and `POSTGRES_PASSWORD` as literals in `docker-compose.yml` (same value on both `app` and `db`). Real app secrets (SESSION_SECRET, S3_*, OPENAI_*, ADMIN_*) stay as Coolify UI vars — Coolify injects those into the service fine. Also note: `EAI_AGAIN db` means the `db` service isn't running — its DB hostname can't resolve.

## CRITICAL: TWO compose files exist — Coolify reads the ROOT one
There are two compose files: `/docker-compose.yml` (repo root) and `/modvolt-knowledge/docker-compose.yml`. **Coolify is configured Base Directory=`/`, Compose Location=`/docker-compose.yml`, so it reads ONLY the root file.** The root file builds the app via `build.context: ./modvolt-knowledge` (the app lives in that subdir). The subdir compose is for standalone/portable local runs and is NOT used by the deploy.
**Why:** Hours were lost editing the subdir compose while Coolify kept reading the stale root compose (which had `db` behind a `with-db` profile so it never started, and never set `DATABASE_URL`). Same error persisted no matter what the subdir file said.
**How to apply:** For any Coolify/deploy change, edit the ROOT `/docker-compose.yml`. The `db` service there must have NO `profiles:` (so it starts by default). Keep both files in sync if you must keep both; better, treat the root file as the single source of truth for deployment.

## Docker build itself is clean — `npm ci` failures are server-side
The Dockerfile `npm ci` reproduces successfully inside the exact `node:24-slim` base. So when Coolify/Hetzner deploys fail at `npm ci`, suspect: (1) Replit proxy URLs in lockfile [see above], (2) ENOSPC disk full on Hetzner, (3) npm registry unreachable. The install step dumps npm debug-log + `df -h` on failure. Base must stay `node:24-slim` (npm 11); `node:22-slim` ships npm 10.9.8 with a genuine "Exit handler never called!" bug. No build toolchain needed (no `apt-get python3 make g++`).

## Testing AI citations must avoid the ČSN lock
A query containing norm keywords (`proudový chránič`, `RCD`, …) forces `csn_only` mode, which filters retrieval to norm/standard document types. An `internal_procedure` test doc is then excluded → 0 chunks → ungrounded fallback answer (correct behavior, not a bug).
**How to apply:** To prove the citation-grounding happy path, use a non-norm query against the uploaded doc's unique content (e.g. a magic constant string).
