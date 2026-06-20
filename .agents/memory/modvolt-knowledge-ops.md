---
name: Modvolt Knowledge operational gotchas
description: Non-obvious runtime/test failure modes for the standalone RAG app (crash-on-rejection, schema drift, S3 endpoint scheme, local auth testing).
---

## Unhandled DB/IO rejections crash the whole server
The Express route handlers (e.g. `/api/search`, `/api/ask`) `await` DB/IO calls WITHOUT try/catch, so any rejected promise becomes a Node `unhandledRejection` and kills the entire server process (not a 500). `tsx watch` will NOT restart it until a source file changes, so the app just goes dark.
**Why:** During live e2e, a single bad query took the whole server down; root cause was schema drift (below), but the crash surfaced as `fetch failed`/`ECONNREFUSED`, masking the real DB error.
**How to apply:** When debugging a server that dies on one request, reproduce the failing operation in isolation via `tsx` (import the service/query directly) to see the real stack — the HTTP path hides it. Wrapping handlers / adding a global handler is a worthwhile hardening follow-up.

## Schema drift = hard crash, run db:migrate
Drizzle migrations live in `modvolt-knowledge/drizzle/`. The DB can lag the schema (pending migrations not auto-applied). A missing column (e.g. `search_queries.csn_lock_*`) makes the insert throw → unhandledRejection → server crash.
**Why:** The `search_queries` table was 2 migrations behind; every `/search` and `/ask` insert crashed the process.
**How to apply:** After any schema change or before live testing, run `npm run db:migrate` (it also creates pgvector + seeds defaults). Verify with `\d <table>` that expected columns exist.

## S3_ENDPOINT must include a scheme
The AWS SDK throws `TypeError: Invalid URL` for endpoints without `http(s)://` (e.g. Hetzner `fsn1.your-objectstorage.com`). `env.ts` now normalizes via `normalizeEndpoint()` (prepends `https://`). HeadBucket/Put/Get/List/Delete all work against Hetzner with `forcePathStyle=true`.
**Why:** User-provided `S3_ENDPOINT` had no scheme; every S3 call (incl. `checkS3Health`) failed, so `s3Reachable` was false despite valid creds.
**How to apply:** Keep the scheme-normalization; don't assume users include `https://`.

## Local HTTP auth testing needs X-Forwarded-Proto: https
Session cookie is `Secure` + `SameSite=None` with `trust proxy=1`. Over plain `http://localhost`, express-session refuses to set/accept the cookie, so every authed request 401s. Send header `x-forwarded-proto: https` on every request to make the connection count as secure. Health route is `/health` (mounted at root), NOT `/api/health`.
**Why:** First e2e attempt 401'd on all authed routes until the forwarded-proto header was added.
**How to apply:** Any script/curl hitting authed endpoints locally must send `x-forwarded-proto: https`. A reusable live test lives at `modvolt-knowledge/scripts/e2e-live-test.mjs`.

## Testing AI citations must avoid the ČSN lock
A query containing norm keywords (`proudový chránič`, `RCD`, …) forces `csn_only` mode, which filters retrieval to norm/standard document types. An `internal_procedure` test doc is then excluded → 0 chunks → ungrounded fallback answer (correct behavior, not a bug).
**How to apply:** To prove the citation-grounding happy path, use a non-norm query against the uploaded doc's unique content (e.g. a magic constant string).
