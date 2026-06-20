import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBatchItems,
  commitBatch,
  type BatchCommitFile,
  type BatchItem,
} from "./batch-commit.js";
import {
  DuplicateDocumentError,
  type CreateDocumentInput,
} from "../documents/document-service.js";

function file(name: string): BatchCommitFile {
  return { buffer: Buffer.from(name), originalname: name, mimetype: "text/plain" };
}

// --- parseBatchItems: zarovnání souborů a metadat -------------------------

test("parseBatchItems rejects invalid JSON", () => {
  const result = parseBatchItems("{ not json", 1);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "Neplatná metadata dávky.");
});

test("parseBatchItems rejects when item count != file count", () => {
  const items = JSON.stringify([{ title: "a" }]);
  const result = parseBatchItems(items, 2);
  assert.equal(result.ok, false);
  assert.equal(
    result.ok === false && result.error,
    "Počet metadat neodpovídá počtu souborů.",
  );
});

test("parseBatchItems rejects more items than files too", () => {
  const items = JSON.stringify([{ title: "a" }, { title: "b" }]);
  const result = parseBatchItems(items, 1);
  assert.equal(result.ok, false);
});

test("parseBatchItems accepts matching count and parses items", () => {
  const items = JSON.stringify([
    { title: "a", skip: false },
    { title: "b", skip: true },
  ]);
  const result = parseBatchItems(items, 2);
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.items.length, 2);
  assert.equal(result.ok === true && result.items[1].skip, true);
});

test("parseBatchItems rejects items that fail the schema", () => {
  // documentType must be a string; a number violates the schema.
  const items = JSON.stringify([{ documentType: 5 }]);
  const result = parseBatchItems(items, 1);
  assert.equal(result.ok, false);
});

test("parseBatchItems counts only items without entryId against uploaded files", () => {
  // Two session entries (entryId) + one uploaded file → uploadedFileCount=1.
  const items = JSON.stringify([
    { title: "z1", entryId: "e1", sessionToken: "t" },
    { title: "z2", entryId: "e2", sessionToken: "t" },
    { title: "upload" },
  ]);
  const result = parseBatchItems(items, 1);
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.items.length, 3);
});

test("parseBatchItems accepts a pure session batch with zero uploaded files", () => {
  const items = JSON.stringify([
    { title: "z1", entryId: "e1", sessionToken: "t" },
    { title: "z2", entryId: "e2", sessionToken: "t" },
  ]);
  const result = parseBatchItems(items, 0);
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.items.length, 2);
});

test("parseBatchItems rejects when uploaded files exceed non-session items", () => {
  // One session entry, no plain items, but a file was uploaded → mismatch.
  const items = JSON.stringify([{ title: "z1", entryId: "e1", sessionToken: "t" }]);
  const result = parseBatchItems(items, 1);
  assert.equal(result.ok, false);
});

// --- commitBatch: per-file isolation + duplicate mapping ------------------

test("commitBatch creates each file independently", async () => {
  const files = [file("a.txt"), file("b.txt")];
  const items: BatchItem[] = [{ title: "A" }, { title: "B" }];
  const created: string[] = [];

  const results = await commitBatch(files, items, "user-1", async (input) => {
    created.push(input.originalFileName);
    return { id: `id-${input.originalFileName}`, title: input.title ?? "" };
  });

  assert.deepEqual(created, ["a.txt", "b.txt"]);
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((r) => r.status),
    ["created", "created"],
  );
  assert.equal(results[0].documentId, "id-a.txt");
});

test("commitBatch maps DuplicateDocumentError to a duplicate result without aborting the batch", async () => {
  const files = [file("a.txt"), file("dup.txt"), file("c.txt")];
  const items: BatchItem[] = [{}, {}, {}];

  const results = await commitBatch(files, items, "user-1", async (input) => {
    if (input.originalFileName === "dup.txt") {
      throw new DuplicateDocumentError("existing-99", "Existující dokument");
    }
    return { id: `id-${input.originalFileName}`, title: "" };
  });

  // The duplicate in the middle must NOT stop the files after it.
  assert.deepEqual(
    results.map((r) => r.status),
    ["created", "duplicate", "created"],
  );
  assert.equal(results[1].existingDocumentId, "existing-99");
  assert.equal(results[2].status, "created");
});

test("commitBatch maps a generic error to status 'error' and continues", async () => {
  const files = [file("a.txt"), file("boom.txt"), file("c.txt")];
  const items: BatchItem[] = [{}, {}, {}];

  const results = await commitBatch(files, items, "user-1", async (input) => {
    if (input.originalFileName === "boom.txt") {
      throw new Error("nahrání selhalo");
    }
    return { id: `id-${input.originalFileName}`, title: "" };
  });

  assert.deepEqual(
    results.map((r) => r.status),
    ["created", "error", "created"],
  );
  assert.equal(results[1].error, "nahrání selhalo");
});

test("commitBatch skips items flagged skip and does not call create for them", async () => {
  const files = [file("a.txt"), file("skip.txt")];
  const items: BatchItem[] = [{}, { skip: true }];
  const created: string[] = [];

  const results = await commitBatch(files, items, "user-1", async (input) => {
    created.push(input.originalFileName);
    return { id: `id-${input.originalFileName}`, title: "" };
  });

  assert.deepEqual(created, ["a.txt"]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["created", "skipped"],
  );
});

test("commitBatch passes through item metadata with safe defaults", async () => {
  const files = [file("a.txt")];
  const items: BatchItem[] = [
    {
      title: "Vlastní název",
      categoryId: "",
      documentType: "norm",
      visibility: "admin_only",
      tagIds: ["t1"],
    },
  ];
  let received: CreateDocumentInput | null = null;

  await commitBatch(files, items, "user-7", async (input) => {
    received = input;
    return { id: "id-1", title: input.title ?? "" };
  });

  assert.ok(received);
  const got = received as CreateDocumentInput;
  assert.equal(got.title, "Vlastní název");
  assert.equal(got.documentType, "norm");
  assert.equal(got.visibility, "admin_only");
  // Empty categoryId is normalized to null (no empty-string FK).
  assert.equal(got.categoryId, null);
  assert.equal(got.uploadedByUserId, "user-7");
  assert.deepEqual(got.tagIds, ["t1"]);
});

test("commitBatch defaults documentType to 'other' and visibility to 'all_users'", async () => {
  const files = [file("a.txt")];
  const items: BatchItem[] = [{}];
  let received: CreateDocumentInput | null = null;

  await commitBatch(files, items, "user-1", async (input) => {
    received = input;
    return { id: "id-1", title: "" };
  });

  const got = received as unknown as CreateDocumentInput;
  assert.equal(got.documentType, "other");
  assert.equal(got.visibility, "all_users");
});

test("commitBatch runs onCreated only for created documents", async () => {
  const files = [file("a.txt"), file("dup.txt"), file("skip.txt")];
  const items: BatchItem[] = [{}, {}, { skip: true }];
  const audited: string[] = [];

  await commitBatch(
    files,
    items,
    "user-1",
    async (input) => {
      if (input.originalFileName === "dup.txt") {
        throw new DuplicateDocumentError("x", "y");
      }
      return { id: `id-${input.originalFileName}`, title: "T" };
    },
    (doc) => {
      audited.push(doc.id);
    },
  );

  assert.deepEqual(audited, ["id-a.txt"]);
});
