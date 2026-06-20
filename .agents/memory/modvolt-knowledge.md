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
Search/filter UI controls (e.g. document-type chips) must send the exact `DocumentType` enum values from `src/shared/types.ts` (`standard`, `norm`, `internal_procedure`, …) — not invented labels like `internal`/`csn_standard`. Mismatched keys silently yield empty filter results because the SQL `ANY` filter never matches.
**Why:** A review caught the search page sending non-canonical type keys; typecheck does not catch this since the filter param is a plain string.
**How to apply:** When adding any filter chip/select, source its option keys from the shared enum, and keep the upload form and search filters using the same canonical set.

## Admin-only UI surface
Categories, tags, indexing, audit, settings, and users pages are admin-gated in BOTH `Layout` nav (`show: isAdmin`) and `App` rendering (`page === ... && isAdmin`). Backend already enforces auth server-side, but the nav/route gating must stay consistent with it.
**Why:** Plan required admin gating; leaving categories/tags visible to all was flagged as a requirement/consistency miss.
**How to apply:** Gate a page in both Layout visibility and App routing together; never gate only one.

## ČSN hard-lock keyword matching must be Unicode-aware
The `csn_only` hard-lock keyword patterns (`resolveSourceMode`) must NOT use JavaScript `\b` next to Czech-diacritic letters (ě, í, č, Č, ů, …). JS `\b` is ASCII-only, so `\buzemnění\b`, `\bČSN\b`, etc. silently never match — leaving norm queries un-locked and able to leak to web search. Use Unicode-aware boundaries: `(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])` with the `u` flag.
**Why:** End-to-end verification found "uzemnění a pospojování" (and most accented norm keywords) were NOT locked; they only appeared to work when the numeric `33 2000` ČSN-series pattern happened to catch the query.
**How to apply:** When adding/editing any ČSN lock keyword, build it via the Unicode-boundary helper, never a raw `\b` literal. Keep only-leading-boundary patterns (e.g. prefix matches like `elektroinstalac`, `IEC\s*\d`) without a trailing boundary.

## Dedup + versioning integrity
`documents.sha256_hash` has a DB-level UNIQUE index (not just a pre-check). Insert/replace paths must catch PG unique violation (code `23505`) and map to a 409 duplicate, in addition to the `findDocumentByHash` pre-check. `replaceDocument` must wrap version-archive insert + chunk `isCurrent=false` demotion + documents update in ONE `db.transaction`. S3 upload happens before the transaction (orphan on failure is harmless since path is hash-derived).
**Why:** Pre-check alone races under concurrent uploads; multi-statement versioning without a transaction can leave inconsistent state.
**How to apply:** Keep the unique index in lockstep with a migration; never split the versioning mutations out of the transaction.

## ČSN lock regex: trailing \b breaks on diacritic-ending words
Several `CSN_LOCK_PATTERNS` in `src/server/search/source-mode.ts` end a Czech word with a trailing `\b` (e.g. `/\bjištění\b/`, `/\bdimenzování (vodičů|kabelů)\b/`, `/\bjisti(č|če|čů|čem)\b/`). JS `\b` (no `u` flag) is an ASCII boundary, so a word ending in `í/ů/č` followed by space or end-of-string yields NO boundary and the pattern never fires. So "Dimenzování vodičů a jištění" does NOT lock to csn_only.
**Why:** Discovered while writing the source-lock tests; queries that clearly concern norms slip through to web-allowed modes.
**How to apply:** When testing the lock, pick queries that match patterns without a trailing-`\b`-after-diacritic problem (ČSN/norma/RCD/IEC/EN/rozvaděč/elektroinstalac all work). A proper fix = drop the trailing `\b` or add the `u` flag with Unicode-aware boundaries; out of scope for the test task.
