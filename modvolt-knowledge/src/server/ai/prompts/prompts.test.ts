import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeSystemPrompt,
  makeCustomPrompt,
  isBuiltInPromptVersion,
  getPrompt,
  DEFAULT_PROMPT_VERSION,
  type PromptContext,
} from "./index.js";

const ctx: PromptContext = {
  sourceMode: "csn_only",
  sourceModeLocked: true,
  webSearchAvailable: false,
  hasImages: false,
};

test("composeSystemPrompt always appends the JSON response schema and source-mode block", () => {
  const out = composeSystemPrompt("VLASTNÍ ZÁKLADNÍ PRAVIDLA", ctx);
  assert.ok(out.includes("VLASTNÍ ZÁKLADNÍ PRAVIDLA"));
  assert.ok(out.includes("FORMÁT ODPOVĚDI (JSON)"));
  assert.ok(out.includes('"citations"'));
  assert.ok(out.includes("REŽIM ZDROJŮ: csn_only"));
});

test("composeSystemPrompt only includes image rules when images are present", () => {
  const without = composeSystemPrompt("X", { ...ctx, hasImages: false });
  const withImages = composeSystemPrompt("X", { ...ctx, hasImages: true });
  assert.ok(!without.includes("ZPRACOVÁNÍ FOTOGRAFIÍ"));
  assert.ok(withImages.includes("ZPRACOVÁNÍ FOTOGRAFIÍ"));
});

test("makeCustomPrompt yields a prompt whose body replaces base rules but keeps schema", () => {
  const custom = makeCustomPrompt("vlastni-1", "popis", "TÓN: stručný a přátelský");
  assert.equal(custom.version, "vlastni-1");
  const built = custom.buildSystemPrompt(ctx);
  assert.ok(built.includes("TÓN: stručný a přátelský"));
  assert.ok(built.includes("FORMÁT ODPOVĚDI (JSON)"));
});

test("isBuiltInPromptVersion recognizes code versions, not custom ones", () => {
  assert.equal(isBuiltInPromptVersion(DEFAULT_PROMPT_VERSION), true);
  assert.equal(isBuiltInPromptVersion("vlastni-1"), false);
});

test("getPrompt falls back to the default version for unknown versions", () => {
  assert.equal(getPrompt("does-not-exist").version, DEFAULT_PROMPT_VERSION);
});
