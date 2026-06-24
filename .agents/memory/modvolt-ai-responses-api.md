---
name: Modvolt AI Responses API
description: Why chat/classification/vision go through OpenAI Responses API, and where embeddings stay separate.
---

All generative AI calls (chat, document classification, image/vision description)
go through the OpenAI **Responses API**, centralized in `ai/openai-responses.ts`
(`createJsonResponse` for JSON output, `createVisionResponse` for image input).
Embeddings stay on the dedicated `embeddings.create` endpoint with the embedding
model — they are NOT part of Responses.

**Why:** the chat model default is a GPT-5 family model (`gpt-5.5`), and Responses
is OpenAI's recommended interface for that family (structured JSON via
`text.format` and image input via `input_image`). Consolidating avoids each
service hand-rolling `chat.completions` calls.

**How to apply:**
- New generative calls use the `openai-responses.ts` helpers, not
  `getOpenAi().chat.completions`. Read `output_text` from the result.
- OpenAI error → user message mapping lives once in `ai/openai-errors.ts`
  (`describeOpenAiError(e, model, envVar?)`); chat path throws 503, classification
  swallows to null. Pass `OPENAI_EMBEDDING_MODEL` as `envVar` for embedding errors.
- Live verification of models/key/dim/pgvector is the admin endpoint
  `GET /admin/ai-diagnostics` (`ai/diagnostics.ts`), surfaced on the Indexing page.
  It actually calls both models and checks the embedding vector length against
  `EMBEDDING_DIMENSIONS` (1536) — never returns the API key, only `hasKey`.
- Tests mock `getOpenAi().responses.create` returning `{ output_text }` (not the
  old `chat.completions` shape).
