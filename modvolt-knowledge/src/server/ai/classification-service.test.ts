import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Toggle + canned response read by the mocks below. Module mocking lets us
// drive classifyDocument without a real OpenAI account.
let openAiUsable = true;
let chatResponse = "{}";
let createCalls = 0;

mock.module("../env.js", {
  namedExports: {
    env: { openai: { chatModel: "gpt-4o-mini" } },
    isChatUsable: () => openAiUsable,
  },
});

mock.module("./openai-client.js", {
  namedExports: {
    getOpenAi: () => ({
      responses: {
        create: async () => {
          createCalls += 1;
          return { output_text: chatResponse };
        },
      },
    }),
  },
});

const { classifyDocument, classificationAvailable } = await import(
  "./classification-service.js"
);

const categories = [
  { id: "cat-1", name: "Elektro" },
  { id: "cat-2", name: "Normy" },
];
const tags = [
  { id: "tag-1", name: "vn" },
  { id: "tag-2", name: "revize" },
];

function baseInput(overrides: Partial<{ text: string; fileName: string }> = {}) {
  return {
    text: "Obsah dokumentu o elektroinstalaci.",
    fileName: "smernice.pdf",
    categories,
    tags,
    ...overrides,
  };
}

beforeEach(() => {
  openAiUsable = true;
  chatResponse = "{}";
  createCalls = 0;
});

test("classificationAvailable reflects isChatUsable", () => {
  openAiUsable = true;
  assert.equal(classificationAvailable(), true);
  openAiUsable = false;
  assert.equal(classificationAvailable(), false);
});

test("returns null (no AI defaults) when OpenAI is disabled and never calls the model", async () => {
  openAiUsable = false;
  const result = await classifyDocument(baseInput());
  assert.equal(result, null);
  assert.equal(createCalls, 0);
});

test("returns null when there is no extractable text (e.g. scanned PDF)", async () => {
  const result = await classifyDocument(baseInput({ text: "   " }));
  assert.equal(result, null);
  assert.equal(createCalls, 0);
});

test("coerces an unknown documentType to the canonical 'other'", async () => {
  chatResponse = JSON.stringify({
    documentType: "totally-made-up",
    categoryId: null,
    tagIds: [],
    title: "Něco",
    description: "popis",
  });
  const result = await classifyDocument(baseInput());
  assert.ok(result);
  assert.equal(result!.documentType, "other");
});

test("keeps a valid canonical documentType", async () => {
  chatResponse = JSON.stringify({ documentType: "norm", title: "Norma" });
  const result = await classifyDocument(baseInput());
  assert.equal(result!.documentType, "norm");
});

test("drops a categoryId that is not an existing category", async () => {
  chatResponse = JSON.stringify({
    documentType: "standard",
    categoryId: "cat-does-not-exist",
  });
  const result = await classifyDocument(baseInput());
  assert.equal(result!.categoryId, null);
});

test("keeps a categoryId that exists", async () => {
  chatResponse = JSON.stringify({
    documentType: "standard",
    categoryId: "cat-2",
  });
  const result = await classifyDocument(baseInput());
  assert.equal(result!.categoryId, "cat-2");
});

test("filters tagIds to existing tags and de-duplicates them", async () => {
  chatResponse = JSON.stringify({
    documentType: "standard",
    tagIds: ["tag-1", "tag-1", "tag-unknown", "tag-2"],
  });
  const result = await classifyDocument(baseInput());
  assert.deepEqual(result!.tagIds, ["tag-1", "tag-2"]);
});

test("falls back to the file name (without extension) when title is empty", async () => {
  chatResponse = JSON.stringify({ documentType: "other", title: "   " });
  const result = await classifyDocument(baseInput({ fileName: "revize-2024.pdf" }));
  assert.equal(result!.title, "revize-2024");
});

test("returns null when the model returns invalid JSON", async () => {
  chatResponse = "this is not json";
  const result = await classifyDocument(baseInput());
  assert.equal(result, null);
});

test("applies schema defaults when fields are missing", async () => {
  chatResponse = JSON.stringify({ title: "Jen název" });
  const result = await classifyDocument(baseInput());
  assert.ok(result);
  assert.equal(result!.documentType, "other");
  assert.equal(result!.categoryId, null);
  assert.deepEqual(result!.tagIds, []);
  assert.equal(result!.description, "");
});
