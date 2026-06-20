---
name: Modvolt runtime-tunable admin settings
description: How prompt version and ČSN lock keywords are made admin-editable at runtime, and the safety floor that always applies.
---

## Runtime settings reads
Admin-tunable behavior in modvolt-knowledge is stored in the `app_settings`
key/value table and read at runtime through a small cached reader (10s TTL).
The cache MUST be invalidated whenever settings are saved (PUT /admin/settings),
otherwise edits won't take effect until the TTL expires / process restarts.
**Why:** the deliverable is "changes take effect without redeploy"; a stale
cache silently breaks that guarantee.
**How to apply:** any new runtime-tunable setting should go through the settings
reader and rely on the existing cache-invalidation on save. New default keys
added to seed-defaults only land via the manual `npm run db:migrate` script —
seeding does NOT run on dev/start boot, so existing DBs won't have a new key
until migrate is run. Always provide a code-level fallback for a missing key.

## ČSN hard-lock has a non-negotiable safety floor
The csn_only source lock is split: built-in structural regexes (norm-number
patterns, ČSN/EN/IEC followed by digits) are always applied in code and cannot
be turned off from the UI; the admin-editable keyword list is additive on top.
**Why:** the ČSN lock is a safety feature (no web for norm questions). Letting
admins clear it entirely would remove a safety guarantee; an empty keyword list
falls back to the built-in defaults rather than disabling matching.
**How to apply:** keyword matching is accent/case-insensitive substring (stems
like "norm", "reviz"), not the original per-pattern regexes. Keep the structural
regexes in code when adding/altering keyword behavior; never make the floor
UI-removable.
