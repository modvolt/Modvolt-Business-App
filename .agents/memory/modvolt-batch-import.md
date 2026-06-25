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
There are two distinct multi-file imports, deliberately kept apart:
- **manual-review batch** (`/batch/analyze` + `/batch/commit`, above): stateless,
  AI-suggested, human approves before commit.
- **bulk background import** (`POST /documents/bulk`): NO review. Accepts many ZIP
  archives + loose files in ONE upload.
**Why:** user wanted memory-safe ingestion of thousands of files / GB archives on
a ~4GB VPS without per-file review.

### `/bulk` must do NOTHING heavy inline — it's a true job queue (502 fix)
The original `/bulk` extracted archives and uploaded every file to S3 INLINE in
the request → a ~200MB archive blew past the reverse-proxy timeout and returned
**502 with no progress**. Durable rule: `POST /bulk` only persists the multer
disk uploads, inserts a `bulk_import_jobs` row (`status=queued`, `sources` jsonb =
`[{path,originalName}]`), triggers the worker, and returns **202 `{jobId}`**. ALL
extraction / `createDocument` / indexing happens in a dedicated background worker
(`indexing/bulk-import-worker.ts`, mirrors `worker.ts`: polling + `UPDATE … FOR
UPDATE SKIP LOCKED`). Progress is tracked on the job row and polled via
`GET /documents/bulk/:jobId` (owner-or-admin only; 2-segment so `GET /:id` can't
shadow it). Client uploads via XHR for upload-% and polls the job for processing-%.
**How to apply:**
- The temp upload files are owned by the WORKER, not the route — the route must
  not delete them (worker rm's per-source AND in a top-level `finally` safety net).
- `processJob` must wrap everything in try/catch: on fatal error set
  `status='failed'`+`lastError` so jobs never wedge in `processing`; `resetStaleJobs`
  flips orphaned `processing` rows to `failed` on boot (can't resume — temp files
  may be gone from /tmp).
- `processedFiles` is DERIVED (`accepted+duplicates+skipped+errors`), single source
  of truth across all branches. `totalFiles` is only an ESTIMATE (`countZipEntries`
  = raw `entryCount`, includes dirs); fine because the bar hides once finished.
- `limitReached` invariant: `streamZipEntries` returns `{ skipped, stopped }` and
  `stopped=true` when `shouldStop` halts it with entries left; worker ORs that into
  `limitReached`. Don't rely solely on `ingest()`'s cap early-return — at the cap
  boundary the next `ingest` may never be called.

### Memory safety is still the whole point (unchanged invariants)
- `/bulk` uses multer **diskStorage** (NOT memoryStorage) — archives can be GB.
- ZIP archives are read with `zip-stream.ts` (`yauzl` + `lazyEntries`): one entry
  in memory at a time; size capped from the header AND while streaming (zip-bomb
  guard); `shouldStop` predicate halts decompression once the file-count cap hits.
- Loose files: reject by size (disk `stat`/multer metadata) BEFORE `readFile` — the
  multer `fileSize` limit allows up to archive size, so never buffer a GB file
  just to discard it. Per-file cap = `env.bulk.maxFileMb` (~200MB).
- `autoClassify` rides on the per-document indexing job; classification failure
  returns null and NEVER fails indexing (doc saved unsorted).
- Limits live in `env.bulk` (`BULK_MAX_FILE_MB`/`MAX_ARCHIVE_MB`/`MAX_ARCHIVES`/
  `MAX_FILES`) — adding any new env var also needs the Coolify compose pass-through
  (see ops gotchas).
