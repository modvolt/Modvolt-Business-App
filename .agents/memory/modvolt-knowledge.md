---
name: Modvolt Knowledge constraints
description: Durable invariants for the modvolt-knowledge standalone RAG app (no Replit runtime dependency).
---

## Portability rule
The `modvolt-knowledge/` app must run with ZERO Replit dependency at runtime/deploy/data layers — deployable via Docker/Coolify on Hetzner. All config via env vars; uses its own `npm` (not pnpm) inside the subdir. It must work WITHOUT OpenAI (AI disabled) and WITHOUT web search.
**Why:** It is delivered to an external company and hosted off-platform.
**How to apply:** Never introduce Replit-managed services/integrations into this subproject; gate every external capability behind an env check with graceful degradation.

## Citation grounding (hard rule)
AI answers must only count a citation toward "sufficiently sourced" if it maps to an actually-retrieved source: internal citations must match a retrieved `chunkId`; web citations must match a retrieved `webResult.url`. If sources existed but no valid citation remains, replace the answer body with a safe Czech fallback and mark `hasSufficientSources=false`, `confidence=low`.
**Why:** Models fabricate plausible citations; an unvalidated citation array lets ungrounded output pass the gate.
**How to apply:** Any change to the chat answer schema/validation must keep filtering citations against the retrieved set BEFORE computing `hasAnyCitation`.

## Frontend filter values must match canonical enums
Search/filter UI controls (e.g. document-type chips) must send the exact `DocumentType` enum values from `src/shared/types.ts` (`standard`, `norm`, `internal_procedure`, …) — not invented labels. Mismatched keys silently yield empty filter results.
**Why:** A review caught the search page sending non-canonical type keys; typecheck does not catch this.
**How to apply:** When adding any filter chip/select, source its option keys from the shared enum.

## Admin-only UI surface
Categories, tags, indexing, audit, settings, and users pages are admin-gated in BOTH `Layout` nav and `App` rendering. Backend enforces auth server-side too; both must stay consistent.
**Why:** Plan required admin gating; leaving categories/tags visible to all was flagged as a requirement miss.
**How to apply:** Gate a page in both Layout visibility and App routing together; never gate only one.

## ČSN hard-lock keyword matching must be Unicode-aware
`csn_only` hard-lock patterns must NOT use JS `\b` next to Czech-diacritic letters (ě, í, č, Č, ů, …). JS `\b` is ASCII-only and silently never matches accented characters.
**Why:** Queries like "uzemnění a pospojování" were not locked, enabling web search on norm queries.
**How to apply:** Use Unicode-aware boundaries (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])` with `u` flag) for any pattern ending in a diacritic character.

## Dedup + versioning integrity
`documents.sha256_hash` has a DB-level UNIQUE index. Insert/replace must catch PG unique violation (code `23505`) and map to 409 duplicate, in addition to the `findDocumentByHash` pre-check. `replaceDocument` must wrap version-archive + chunk demotion + document update in ONE `db.transaction`.
**Why:** Pre-check alone races under concurrent uploads; multi-statement versioning without a transaction can leave inconsistent state.
**How to apply:** Keep the unique index in lockstep with a migration; never split the versioning mutations out of the transaction.

## Migration rules
- Migrations do NOT auto-apply on server start — must be run manually (`npm run db:migrate`) after each deployment.
- `db:seed-admin` is one-time bootstrap; safe to re-run (idempotent — won't overwrite existing admin).
- Migration 0004 added FK CASCADE/SET NULL. It includes orphan-row cleanup at the top to avoid ALTER TABLE failures on existing data.
- When adding future migrations with FK constraints: always prepend orphan cleanup (DELETE orphans for CASCADE, UPDATE SET NULL for nullable FKs) before the ALTER TABLE statements.

## FK cascade chain (after migration 0004)
- DELETE document → cascades to: documentChunks, documentVersions, documentTagLinks, indexingJobs
- DELETE documentChunk → cascades to: documentEmbeddings
- DELETE chatSession → cascades to: chatMessages → webCitations
- DELETE user → cascades to: chatSessions; documents/documentVersions.uploadedByUserId SET NULL
- DELETE documentCategory → documents.categoryId SET NULL
- documentTagLinks.tagId → CASCADE (deleting a tag removes its links)

## Security layers (production hardening done)
- Helmet: HTTP security headers in app.ts (HSTS only in prod).
- Rate limit: POST /login max 10 failed attempts / 15 min / IP (`skipSuccessfulRequests: true`).
- Origin guard: blocks cross-origin POST/PUT/PATCH/DELETE in prod or when APP_BASE_URL is set. No-Origin requests (curl, server-to-server) are allowed.
- /health returns only `{status, version, time}`. Full infra status on GET /api/admin/system-health (requires admin session).

## Upload limits (env-configurable)
- OPENAI_MAX_UPLOAD_MB default: 15 (was 50 before audit)
- MAX_BATCH_FILES default: 10 (was 50 hardcoded in document-routes.ts)
- MAX_ZIP_MB default: 100

## EXIF handling
- sharp without .withMetadata() never writes EXIF. `exifRemoved` is always `true` regardless of STRIP_IMAGE_EXIF env var (legacy flag kept for config compatibility only).

## Docker non-root
- Runtime stage: all COPY use `--chown=node:node`, `USER node` before CMD (uid 1000, built into node:24-slim).
- Import session temp files go to `os.tmpdir()` (/tmp), writable by the node user — no extra volume needed.

## Test / verify commands
- `npm test` — node:test runner, tsx, 49 tests, no external services needed
- `npm run typecheck` — tsc --noEmit
- `npm run build` — vite (client) + esbuild (server)
- `npm run verify` — ci + typecheck + test + build (full gate)
- From monorepo root: `pnpm run verify:knowledge`
