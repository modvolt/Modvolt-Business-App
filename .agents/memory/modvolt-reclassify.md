---
name: Modvolt reclassify existing documents
description: Re-running AI classification on docs already in the library; why no reindex is needed.
---

## Reclassifying existing documents only touches metadata
Admins can select existing documents and re-run the AI classifier on them
(analyze → review → commit), mirroring the batch-import flow but for stored
docs. Analyze fetches the stored object via `getObjectBuffer(objectPath)`,
extracts text, and runs the same `classifyDocument` (constrained to canonical
`DocumentType` + existing category/tag IDs). Commit updates document rows and
tag links per-item, isolated in a loop so one failure never aborts the rest.

**Why no reindex for metadata-only changes:** search reads `document_type` and
`title` via a live JOIN to `documents` (`search-service.ts` fulltext/vector
queries `JOIN documents d ON d.id = c.document_id`), so type/category/tags/title
edits reflect in retrieval immediately without rebuilding chunks. Reindex is
re-enqueued only when a doc's status is not `indexed` (it never finished
indexing), to push it back into the queue.

**How to apply:** any future "edit metadata in bulk" feature can skip reindex
for type/category/tags/title/description; only content changes (new file
version, which `replaceDocument` already handles) require reindexing.
