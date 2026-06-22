---
name: Modvolt error-handling convention
description: How API errors carry status + safe message, how the central handler exposes vs. masks them, and what the frontend shows.
---

## Typed errors carry HTTP status + a user-safe message
Operational failures throw an `AppError` subclass (`BadRequestError` 400, `NotFoundError` 404, `ConflictError` 409, `ServiceUnavailableError` 503) from `server/lib/errors.ts`. Each carries `status` + `expose: true`. `DuplicateDocumentError` and `PromptStoreError` extend `AppError` too.
**Why:** Before this, handlers did `throw new Error("…")` and the global handler returned a blanket 500 "Interní chyba serveru." for everything, so the real cause (bad input / not found / storage down / AI off) was invisible and the status was always wrong.
**How to apply:** When a handler hits an *expected* failure, throw the matching `AppError` subclass with a concrete Czech message — do NOT hand-roll `res.status(500)` or `throw new Error`. Let it bubble to the central handler (route handlers are auto-wrapped by `createRouter`/`asyncHandler`, so `throw` becomes `next(err)`). Keep raw internal strings (stack, connection details, OpenAI errors) OUT of the message — log them instead.

## Central handler: expose operational, mask unexpected with an incident id
`app.ts` calls `describeError(err)`. If `expose === true` it returns that error's status + message verbatim (logged at WARN). Otherwise it logs at ERROR with a short `incidentId` (`crypto.randomUUID().slice(0,8)`) + stack, and returns 500 `{ error: "Interní chyba serveru. (kód incidentu: <id>)", incidentId }`.
**Why:** Unexpected errors must stay generic (no detail leak) but still be traceable — the id in the user's message matches the id in the server log.
**How to apply:** Anything that should reach the user as a specific message MUST be an `AppError` (or carry numeric `status` + `expose:true`). Anything else is treated as a leak risk and masked.

## Frontend already surfaces the API message
`client/lib/api.ts` throws `Error(data?.error || "Chyba <status>")` (JSON parse is guarded so a non-JSON body falls back to the status). Pages show `(err as Error).message`. Row-level flows (batch import / reclassify) put the per-item real cause in each row's `error` field server-side; the client renders that, not a generic placeholder.
**How to apply:** Don't reintroduce generic client-side strings like "Bez výsledku analýzy" — prefer the server-provided cause; the status fallback is only for a completely missing/unparseable body.
