import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as schema from "../db/schema.js";

// --- Stav řízený mocky -----------------------------------------------------
// Tyto testy hlídají bezpečnostní bránu OCR: drahý OpenAI vision se smí spustit
// jen u skenu bez textové vrstvy, když je OCR zapnuté A bylo cíleně vyžádáno
// (jobType "ocr") nebo dokument už dříve přes OCR prošel. Module mocking nahradí
// DB, úložiště, extrakci i OCR, takže testujeme čistě rozhodovací logiku.

let doc: Record<string, unknown> | null = null;
let extraction: { needsOcr: boolean; fullText: string } = {
  needsOcr: false,
  fullText: "",
};
let ocrUsable = true;
let ocrCalls = 0;
let ocrResult: { fullText: string; pageCount: number; truncated: boolean } = {
  fullText: "",
  pageCount: 0,
  truncated: false,
};
let ocrError: Error | null = null;

// Poslední hodnoty zapsané do tabulek (sledujeme výsledný stav dokumentu/jobu).
let docState: Record<string, unknown> = {};
let jobState: Record<string, unknown> = {};
let failedViaPool = false;

const fakeDb = {
  select() {
    return {
      from() {
        return {
          where() {
            return { limit: async () => (doc ? [doc] : []) };
          },
        };
      },
    };
  },
  update(table: unknown) {
    return {
      set(vals: Record<string, unknown>) {
        return {
          where: async () => {
            if (table === schema.documents) Object.assign(docState, vals);
            else if (table === schema.indexingJobs) Object.assign(jobState, vals);
          },
        };
      },
    };
  },
  delete() {
    return { where: async () => {} };
  },
  insert() {
    return {
      values(arr: { content: string }[]) {
        return {
          returning: async () =>
            arr.map((c, i) => ({ id: `chunk-${i}`, content: c.content })),
        };
      },
    };
  },
};

const fakePool = {
  query: async (sql: string) => {
    if (/UPDATE indexing_jobs SET status='failed'/.test(sql)) {
      failedViaPool = true;
    }
    return { rows: [] };
  },
};

mock.module("../db/index.js", {
  namedExports: { db: fakeDb, pool: fakePool },
});

mock.module("../storage/s3.js", {
  namedExports: {
    getObjectBuffer: async () => Buffer.from("rawfile"),
  },
});

mock.module("../documents/text-extraction.js", {
  namedExports: {
    extractText: async () => extraction,
  },
});

mock.module("../documents/chunking.js", {
  namedExports: {
    chunkText: (text: string) =>
      text.trim().length === 0
        ? []
        : [
            {
              chunkIndex: 0,
              pageNumber: 1,
              sectionTitle: null,
              content: text,
              tokenCount: 5,
            },
          ],
  },
});

mock.module("../ai/embeddings.js", {
  namedExports: {
    embeddingsAvailable: () => false,
    createEmbedding: async () => [],
    createEmbeddings: async () => [],
    toVectorLiteral: () => "[]",
  },
});

mock.module("../env.js", {
  namedExports: {
    env: { openai: { embeddingBatchSize: 1, embeddingModel: "m" } },
    isOcrUsable: () => ocrUsable,
  },
});

mock.module("../documents/ocr.js", {
  namedExports: {
    ocrPdf: async () => {
      ocrCalls += 1;
      if (ocrError) throw ocrError;
      return ocrResult;
    },
  },
});

mock.module("../lib/logger.js", {
  namedExports: {
    logger: { info() {}, warn() {}, error() {} },
  },
});

const { processJob } = await import("./worker.js");

function pdfDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    objectPath: "path/doc.pdf",
    mimeType: "application/pdf",
    originalFileName: "doc.pdf",
    ocrApplied: false,
    ...overrides,
  };
}

beforeEach(() => {
  doc = pdfDoc();
  extraction = { needsOcr: true, fullText: "" };
  ocrUsable = true;
  ocrCalls = 0;
  ocrResult = { fullText: "", pageCount: 0, truncated: false };
  ocrError = null;
  docState = {};
  jobState = {};
  failedViaPool = false;
});

// --- Rozhodnutí, zda vůbec spustit OCR -------------------------------------

test("běžný index skenu OCR nespouští a končí ve stavu needs_ocr", async () => {
  doc = pdfDoc({ ocrApplied: false });
  await processJob("job-1", "doc-1", "index");
  assert.equal(ocrCalls, 0);
  assert.equal(docState.status, "needs_ocr");
  assert.equal(jobState.status, "done");
});

test("reindex skenu OCR nespouští a končí ve stavu needs_ocr", async () => {
  doc = pdfDoc({ ocrApplied: false });
  await processJob("job-1", "doc-1", "reindex");
  assert.equal(ocrCalls, 0);
  assert.equal(docState.status, "needs_ocr");
});

test("cílený job 'ocr' OCR spustí", async () => {
  doc = pdfDoc({ ocrApplied: false });
  ocrResult = { fullText: "Dostatečně dlouhý OCR text.", pageCount: 1, truncated: false };
  await processJob("job-1", "doc-1", "ocr");
  assert.equal(ocrCalls, 1);
});

test("reindex dokumentu, který už přes OCR prošel, OCR spustí", async () => {
  doc = pdfDoc({ ocrApplied: true });
  ocrResult = { fullText: "Dostatečně dlouhý OCR text.", pageCount: 1, truncated: false };
  await processJob("job-1", "doc-1", "reindex");
  assert.equal(ocrCalls, 1);
});

test("vypnuté OCR brání i cílenému jobu 'ocr'", async () => {
  ocrUsable = false;
  doc = pdfDoc({ ocrApplied: false });
  await processJob("job-1", "doc-1", "ocr");
  assert.equal(ocrCalls, 0);
  assert.equal(docState.status, "needs_ocr");
});

test("vypnuté OCR brání i dokumentu, který už přes OCR prošel", async () => {
  ocrUsable = false;
  doc = pdfDoc({ ocrApplied: true });
  await processJob("job-1", "doc-1", "reindex");
  assert.equal(ocrCalls, 0);
  assert.equal(docState.status, "needs_ocr");
});

test("cílený job 'ocr' nad ne-PDF OCR nespustí", async () => {
  doc = pdfDoc({ mimeType: "text/plain", originalFileName: "scan.txt" });
  await processJob("job-1", "doc-1", "ocr");
  assert.equal(ocrCalls, 0);
  assert.equal(docState.status, "needs_ocr");
});

// --- Výsledky OCR ----------------------------------------------------------

test("sken s textovou vrstvou se indexuje bez OCR a bez OCR příznaku", async () => {
  extraction = { needsOcr: false, fullText: "Dokument má vlastní textovou vrstvu." };
  await processJob("job-1", "doc-1", "index");
  assert.equal(ocrCalls, 0);
  assert.equal(docState.status, "indexed");
  assert.equal(docState.ocrApplied, false);
});

test("selhání OCR ponechá dokument v needs_ocr, ne ve failed", async () => {
  doc = pdfDoc({ ocrApplied: false });
  ocrError = new Error("vision selhalo");
  await processJob("job-1", "doc-1", "ocr");
  assert.equal(ocrCalls, 1);
  assert.equal(docState.status, "needs_ocr");
  assert.notEqual(docState.status, "failed");
  assert.equal(failedViaPool, false);
});

test("OCR bez využitelného textu skončí v needs_ocr, ne ve failed", async () => {
  doc = pdfDoc({ ocrApplied: false });
  ocrResult = { fullText: "krátké", pageCount: 1, truncated: false };
  await processJob("job-1", "doc-1", "ocr");
  assert.equal(ocrCalls, 1);
  assert.equal(docState.status, "needs_ocr");
});

test("úspěšné OCR označí dokument jako indexed s OCR příznakem", async () => {
  doc = pdfDoc({ ocrApplied: false });
  ocrResult = {
    fullText: "Tohle je dostatečně dlouhý rozpoznaný text z OCR.",
    pageCount: 2,
    truncated: false,
  };
  await processJob("job-1", "doc-1", "ocr");
  assert.equal(ocrCalls, 1);
  assert.equal(docState.status, "indexed");
  assert.equal(docState.ocrApplied, true);
  assert.equal(docState.textExtracted, true);
});
