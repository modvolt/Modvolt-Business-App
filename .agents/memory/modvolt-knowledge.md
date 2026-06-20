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

## Dedup + versioning integrity
`documents.sha256_hash` has a DB-level UNIQUE index (not just a pre-check). Insert/replace paths must catch PG unique violation (code `23505`) and map to a 409 duplicate, in addition to the `findDocumentByHash` pre-check. `replaceDocument` must wrap version-archive insert + chunk `isCurrent=false` demotion + documents update in ONE `db.transaction`. S3 upload happens before the transaction (orphan on failure is harmless since path is hash-derived).
**Why:** Pre-check alone races under concurrent uploads; multi-statement versioning without a transaction can leave inconsistent state.
**How to apply:** Keep the unique index in lockstep with a migration; never split the versioning mutations out of the transaction.
