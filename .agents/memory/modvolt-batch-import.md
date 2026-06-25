---
name: Modvolt batch & bulk import design
description: The three multi-file import flows (manual-review batch, bulk background job, chunked upload transport) and their durable invariants.
---

## Three distinct multi-file flows, deliberately separate
- **manual-review batch** (`/documents/batch/analyze` + `/batch/commit`): stateless —
  server keeps NO buffers between steps; client re-uploads `File`s on commit. Analyze
  returns per-file AI suggestions + SHA-256 dup detection; commit re-receives files +
  an index-aligned `items` array. **Why:** zero-runtime-dep portability for
  locally-picked files. **Apply:** keep files↔items index-aligned; each file handled
  independently so one failure never aborts the batch (duplicate → per-file result, not
  a whole-request 409); AI output constrained to canonical enum + existing IDs, degrades
  to null when OpenAI off.
- **bulk background import** (`POST /documents/bulk`): NO review; many ZIPs + loose
  files in one go, for thousands of files / GB archives on a ~4GB VPS.

## Bulk = true job queue (the original 502 fix)
Never do heavy work inline in a request — a ~200MB archive extracted+uploaded inline
blows the reverse-proxy timeout → **502 with no progress**. Durable rule: the route only
persists the upload, inserts a `bulk_import_jobs` row, triggers the worker, returns
**202 {jobId}**. ALL extraction/createDocument/indexing runs in a background worker
(polling + `FOR UPDATE SKIP LOCKED`); progress polled via `GET /documents/bulk/:jobId`
(owner-or-admin; 2-segment path so `GET /:id` can't shadow it).
**Apply:**
- Temp upload files are owned by the WORKER, not the route — route must not delete them.
- `processJob` wraps everything in try/catch and sets `failed`+`lastError` on fatal
  error; orphaned `processing` rows are flipped to `failed` on boot (can't resume —
  /tmp temp files may be gone).
- Progress `processedFiles` is DERIVED (accepted+duplicates+skipped+errors); `totalFiles`
  is only an estimate.
- `limitReached`: trust `streamZipEntries`'s `{stopped}` (true when the cap halts it with
  entries left), not just `ingest()`'s early-return.

## Memory-safety invariants (whole point of bulk)
- multer **diskStorage**, never memoryStorage — archives can be GB.
- ZIP read via `yauzl` lazyEntries: one entry in memory at a time; size capped from
  header AND while streaming (zip-bomb guard); `shouldStop` halts at the file-count cap.
- Loose files: reject by size (stat/metadata) BEFORE readFile, so a GB file is never
  buffered just to discard it.
- `autoClassify` rides the per-document indexing job; classification failure → null,
  never fails indexing.
- Limits in `env.bulk` — any new env var also needs the Coolify compose pass-through.

## Chunked + resumable upload transport (second 502 fix: upload itself)
After making bulk a job queue, a single 208MB ZIP still 502'd because the whole upload
had to arrive in ONE request before the server replied — any stall on flaky internet
killed it. Durable rule: large uploads go through a **filesystem-backed session** —
`POST /bulk/session` (init, validates size/count, returns uploadId+chunkSize), repeated
`POST /bulk/session/:id/chunk` (~5MB each, multer memoryStorage), then
`POST /bulk/session/:id/commit` (assemble → verify contiguous indices + total bytes →
insert job → 202). All endpoints `requireWriteAccess` + owner-or-admin IDOR guard.
**Apply:**
- writeChunk is atomic (.part + rename) and idempotent; assemble verifies contiguity and
  exact total size before creating the job.
- **Resume is client-driven, best-effort identity:** client persists uploadId in
  localStorage keyed by a fingerprint of `name+size+lastModified` per file; on retry it
  GETs `/bulk/session/:id`, and only reuses/skips already-received chunks when name AND
  size AND lastModified all match (server stores+returns lastModified). Any mismatch →
  fresh session. This is NOT cryptographic content verification — it's the
  tus/Resumable.js heuristic, chosen to avoid hashing 208MB; a regenerated file gets a
  new mtime so it can't alias an old session.
- Clear the saved session on successful commit or a permanent 4xx; keep it on transient
  network failure so the user can resume.
- Stale `/tmp` sessions must be GC'd at boot AND periodically (hourly `setInterval`,
  `.unref()`), or abandoned sessions grow unbounded → ENOSPC on a small VPS.
- Server HTTP timeouts must tolerate slow chunks: `requestTimeout=0`, generous
  headers/keepAlive timeouts.
