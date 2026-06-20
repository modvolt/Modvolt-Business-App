---
name: Modvolt ZIP import session store
description: Why expanded ZIP entries are held server-side (disk) and referenced by token, not re-uploaded as base64.
---

## ZIP expansion uses a short-lived server-side import session
`POST /documents/batch/zip` expands the archive, writes each accepted entry to a
disk temp file, and returns only lightweight metadata: `sessionToken`, plus per
entry `{ entryId, fileName, sizeBytes }`. No bytes go back to the browser.
`/batch/analyze` and `/batch/commit` resolve those bytes from the store via
`sessionToken` + `entryId` instead of the client re-uploading them.

**Why:** the original design base64'd every entry down to the browser, which then
rebuilt File objects and re-uploaded them — bytes crossed the wire three times
and lived in memory on both ends. Disk-backed temp files keep one copy off-heap
and only read one entry at a time. The task "Speed up large zip imports and
reduce memory use" deliberately overrode the older fully-stateless preference for
the ZIP path only.

**How to apply:**
- Locally-picked (non-zip) files still upload normally via multipart `files` and
  stay stateless — only the zip path uses the session store.
- `batch-commit` items can carry `entryId` + `sessionToken` (+ `fileName` for
  error reporting). `parseBatchItems` validates that the count of items WITHOUT
  `entryId` equals the uploaded-file count; session items are extra.
- The commit route builds a resolved file list in item order, pulling uploaded
  files sequentially for non-entry items and reading the store for entry items;
  results are mapped back to original item indices so per-item isolation holds.
- A missing/expired entry becomes a per-item error ("Relace importu vypršela…"),
  never a whole-batch failure. Sessions are user-scoped (token+userId) and expire
  (~30 min) via a TTL sweeper; files live under `os.tmpdir()/modvolt-import-sessions`.
- Store module: `src/server/documents/import-session.ts`.
