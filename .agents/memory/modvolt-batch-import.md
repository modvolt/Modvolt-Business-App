---
name: Modvolt batch import design
description: How batch document import (analyze + commit) is structured and why it is stateless.
---

## Batch import is two stateless requests (analyze, then commit)
Batch import does NOT keep uploaded buffers server-side between steps. The
client holds the `File` objects and re-uploads them on commit. `/documents/batch/analyze`
returns per-file AI suggestions + SHA-256 duplicate detection; `/documents/batch/commit`
re-receives the files plus a parallel `items` JSON array (matched by index) and
creates each document via the existing `createDocument` pipeline.
**Why:** the app must run with zero Replit/runtime dependency and be portable
(Docker/Coolify). Re-upload keeps both endpoints stateless for locally-picked
files.
**How to apply:** keep files↔items strictly index-aligned (same order). Each
file is handled independently in a loop so one failure never aborts the batch;
DuplicateDocumentError maps to a per-file "duplicate" result, not a 409 for the
whole request. AI classification is constrained to canonical `DocumentType`
values + existing category/tag IDs (model output filtered server-side), and
degrades to null suggestions (defaults: type "other") when OpenAI is off.

## Bulk background import is a SEPARATE flow from manual-review batch
There are now two distinct multi-file imports, deliberately kept apart:
- **manual-review batch** (`/batch/analyze` + `/batch/commit`, above): stateless,
  AI-suggested, human approves before commit.
- **bulk background import** (`POST /documents/bulk`): NO review. Accepts many ZIP
  archives + loose files in ONE upload, just calls `createDocument` per file
  (storage + `indexing_jobs` queue) and returns immediately; the polling worker
  indexes on the background. An optional `autoClassify` flag makes the worker run
  AI classification after extraction. Progress via `GET /documents/queue-status`.
**Why:** user wanted memory-safe ingestion of thousands of files / GB archives on
a ~4GB VPS without per-file review. Reusing the existing queue keeps it sequential
and bounded.
**How to apply (memory safety is the whole point):**
- `/bulk` uses multer **diskStorage** (NOT memoryStorage) — archives can be GB.
- ZIP archives are read with `zip-stream.ts` (`yauzl` + `lazyEntries`): one entry
  in memory at a time; size capped from the header AND while streaming (zip-bomb
  guard); `shouldStop` predicate halts decompression once the file-count cap hits.
- Loose files: reject by `file.size` (multer metadata) BEFORE `readFile` — the
  multer `fileSize` limit allows up to archive size, so never buffer a GB file
  just to discard it. Per-file cap = `env.bulk.maxFileMb` (~200MB).
- `autoClassify` rides on `indexing_jobs.auto_classify`; worker threads it through
  enqueue→claim→process→indexFullText. The worker loads AI modules
  (`classification-service`, `classification-options`, `document-service`) via
  **dynamic import inside the classify path**, NOT static top-level imports — this
  keeps the worker's static module graph small so `worker.test.ts` mocks don't
  need to stub the AI/openai chain, and AI deps load only when actually used.
- Classification failure returns null and NEVER fails indexing (doc saved unsorted).
- Limits live in `env.bulk` (`BULK_MAX_FILE_MB`/`MAX_ARCHIVE_MB`/`MAX_ARCHIVES`/
  `MAX_FILES`) — adding any new env var also needs the Coolify compose pass-through
  (see ops gotchas).
