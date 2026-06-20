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
(Docker/Coolify); a server-side temp store of large buffers would add state,
memory pressure, and a cleanup burden. Re-upload keeps both endpoints stateless.
**How to apply:** keep files↔items strictly index-aligned (same order). Each
file is handled independently in a loop so one failure never aborts the batch;
DuplicateDocumentError maps to a per-file "duplicate" result, not a 409 for the
whole request. AI classification is constrained to canonical `DocumentType`
values + existing category/tag IDs (model output filtered server-side), and
degrades to null suggestions (defaults: type "other") when OpenAI is off.
