import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Mutable toggles driving the mocks below, so each test can exercise a
// different path of collectAiDiagnostics without any real network or DB.
let enabled = false;
let hasKey = true;
let embeddingVec: number[] = new Array(1536).fill(0);
let pgvectorRows = 1;
let chatOutput = '{"ok":true}';

mock.module("../env.js", {
  namedExports: {
    env: {
      openai: {
        apiKey: hasKey ? "sk-test" : "",
        baseUrl: "",
        chatModel: "gpt-5.5",
        embeddingModel: "text-embedding-3-small",
        imageAnalysisEnabled: false,
      },
    },
    isOpenAiUsable: () => enabled,
  },
});

mock.module("./openai-client.js", {
  namedExports: {
    getOpenAi: () => ({
      responses: {
        create: async () => ({ output_text: chatOutput }),
      },
      embeddings: {
        create: async () => ({ data: [{ embedding: embeddingVec }] }),
      },
    }),
  },
});

mock.module("../db/index.js", {
  namedExports: {
    db: { select: () => ({ from: async () => [{ c: 0 }] }) },
    pool: { query: async () => ({ rowCount: pgvectorRows }) },
  },
});

mock.module("../db/schema.js", {
  namedExports: {
    EMBEDDING_DIMENSIONS: 1536,
    documentChunks: {},
    documentEmbeddings: {},
  },
});

const { collectAiDiagnostics } = await import("./diagnostics.js");

beforeEach(() => {
  enabled = false;
  hasKey = true;
  embeddingVec = new Array(1536).fill(0);
  pgvectorRows = 1;
  chatOutput = '{"ok":true}';
});

test("disabled AI reports a clear cause and skips live tests", async () => {
  enabled = false;
  const d = await collectAiDiagnostics();
  assert.equal(d.openaiEnabled, false);
  assert.equal(d.chatTest.ok, false);
  assert.equal(d.embeddingTest.ok, false);
  assert.ok(d.chatTest.cause);
  assert.equal(d.expectedDimension, 1536);
  assert.equal(d.actualDimension, null);
  assert.equal(d.dimensionMatch, null);
});

test("enabled AI with matching dimension passes both tests", async () => {
  enabled = true;
  const d = await collectAiDiagnostics();
  assert.equal(d.chatTest.ok, true);
  assert.equal(d.embeddingTest.ok, true);
  assert.equal(d.actualDimension, 1536);
  assert.equal(d.dimensionMatch, true);
  assert.equal(d.pgvectorAvailable, true);
});

test("a wrong embedding dimension is reported as a mismatch error", async () => {
  enabled = true;
  embeddingVec = [0, 0, 0];
  const d = await collectAiDiagnostics();
  assert.equal(d.embeddingTest.ok, false);
  assert.equal(d.actualDimension, 3);
  assert.equal(d.dimensionMatch, false);
  assert.match(d.embeddingTest.cause ?? "", /1536/);
});

test("an empty chat response is NOT reported as healthy", async () => {
  enabled = true;
  chatOutput = "";
  const d = await collectAiDiagnostics();
  assert.equal(d.chatTest.ok, false);
  assert.ok(d.chatTest.cause);
});

test("a malformed chat response is NOT reported as healthy", async () => {
  enabled = true;
  chatOutput = "this is not json";
  const d = await collectAiDiagnostics();
  assert.equal(d.chatTest.ok, false);
  assert.ok(d.chatTest.cause);
});

test("missing pgvector extension is reported", async () => {
  enabled = true;
  pgvectorRows = 0;
  const d = await collectAiDiagnostics();
  assert.equal(d.pgvectorAvailable, false);
});
