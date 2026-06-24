import { test } from "node:test";
import assert from "node:assert/strict";
import { describeOpenAiError } from "./openai-errors.js";

test("401/403 map to a missing/invalid key cause", () => {
  assert.match(describeOpenAiError({ status: 401 }, "gpt-5.5"), /OPENAI_API_KEY/);
  assert.match(describeOpenAiError({ status: 403 }, "gpt-5.5"), /OPENAI_API_KEY/);
});

test("404 / model_not_found names the configured model and env var", () => {
  const chat = describeOpenAiError({ status: 404 }, "gpt-5.5");
  assert.match(chat, /gpt-5\.5/);
  assert.match(chat, /OPENAI_CHAT_MODEL/);

  const emb = describeOpenAiError(
    { code: "model_not_found" },
    "text-embedding-3-small",
    "OPENAI_EMBEDDING_MODEL",
  );
  assert.match(emb, /text-embedding-3-small/);
  assert.match(emb, /OPENAI_EMBEDDING_MODEL/);
});

test("429 maps to a rate-limit / credit cause", () => {
  assert.match(describeOpenAiError({ status: 429 }, "gpt-5.5"), /limit|kredit/);
});

test("timeouts and dropped connections map to a timeout cause", () => {
  assert.match(
    describeOpenAiError({ code: "ETIMEDOUT" }, "gpt-5.5"),
    /časový limit|spojení/,
  );
  assert.match(
    describeOpenAiError({ message: "Premature close" }, "gpt-5.5"),
    /časový limit|spojení/,
  );
});

test("unknown errors fall back to a generic provider cause with HTTP status", () => {
  assert.match(
    describeOpenAiError({ status: 500 }, "gpt-5.5"),
    /HTTP 500/,
  );
});
