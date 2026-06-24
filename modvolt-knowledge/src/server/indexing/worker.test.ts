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

// --- Stav pro testy embeddingů (embedChunks: dávka -> fallback po jednom) ----
let embeddingsOn = false;
// Když je nastaveno, chunkText vrátí přesně tyto chunky (jinak default 1 chunk).
let chunkOverride:
  | {
      chunkIndex: number;
      pageNumber: number;
      sectionTitle: string | null;
      content: string;
      tokenCount: number;
    }[]
  | null = null;
let batchSize = 1;
// Záznam volání: každé volání createEmbeddings (dávka) a createEmbedding (po jednom).
let embedBatchCalls: string[][] = [];
let embedSingleCalls: string[] = [];
// Co skončilo zapsané do document_embeddings (chunk_id v pořadí vložení).
let embeddingInserts: string[] = [];
// Řízení selhání: vrať true a daný vstup "selže".
let batchShouldFail: (texts: string[]) => boolean = () => false;
let singleShouldFail: (text: string) => boolean = () => false;

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
  query: async (sql: string, params?: unknown[]) => {
    if (/UPDATE indexing_jobs SET status='failed'/.test(sql)) {
      failedViaPool = true;
    }
    if (/INSERT INTO document_embeddings/.test(sql)) {
      embeddingInserts.push(String(params?.[0]));
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
    chunkText: (text: string) => {
      if (chunkOverride) return chunkOverride;
      return text.trim().length === 0
        ? []
        : [
            {
              chunkIndex: 0,
              pageNumber: 1,
              sectionTitle: null,
              content: text,
              tokenCount: 5,
            },
          ];
    },
  },
});

mock.module("../ai/embeddings.js", {
  namedExports: {
    embeddingsAvailable: () => embeddingsOn,
    createEmbedding: async (text: string) => {
      embedSingleCalls.push(text);
      if (singleShouldFail(text)) throw new Error("single failed");
      return [0.3, 0.4];
    },
    createEmbeddings: async (texts: string[]) => {
      embedBatchCalls.push(texts);
      if (batchShouldFail(texts)) throw new Error("batch failed");
      return texts.map(() => [0.1, 0.2]);
    },
    toVectorLiteral: () => "[]",
  },
});

mock.module("../env.js", {
  namedExports: {
    env: {
      openai: {
        get embeddingBatchSize() {
          return batchSize;
        },
        embeddingModel: "m",
      },
    },
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
  embeddingsOn = false;
  chunkOverride = null;
  batchSize = 1;
  embedBatchCalls = [];
  embedSingleCalls = [];
  embeddingInserts = [];
  batchShouldFail = () => false;
  singleShouldFail = () => false;
});

// Pomocník: dokument s textovou vrstvou (jde rovnou do embeddingové cesty).
function chunk(content: string, i: number) {
  return {
    chunkIndex: i,
    pageNumber: 1,
    sectionTitle: null,
    content,
    tokenCount: 5,
  };
}

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

// --- Embeddingy: dávkování a fallback po jednom chunku ----------------------
// embedChunks počítá embeddingy po dávkách; když dávka selže (síťové „Premature
// close" nebo jeden vadný chunk), degraduje na embedding po jednom chunku, aby
// jeden problém nepoložil celý dokument. U jediného chunku se chyba vyhodí
// (žádná nekonečná degradace). Tyto testy jdou skrz textovou vrstvu dokumentu
// (needsOcr=false), takže se dostaneme rovnou do indexační/embeddingové cesty.

test("zdravá dávka zaembedduje všechny chunky jedním voláním", async () => {
  embeddingsOn = true;
  batchSize = 10;
  chunkOverride = [chunk("A", 0), chunk("B", 1), chunk("C", 2)];
  extraction = { needsOcr: false, fullText: "nezáleží – chunky řídí override" };

  await processJob("job-1", "doc-1", "index");

  // Jedno dávkové volání se všemi třemi texty, žádný fallback po jednom.
  assert.equal(embedBatchCalls.length, 1);
  assert.deepEqual(embedBatchCalls[0], ["A", "B", "C"]);
  assert.equal(embedSingleCalls.length, 0);
  // Všechny tři chunky se zapsaly do document_embeddings.
  assert.deepEqual(embeddingInserts, ["chunk-0", "chunk-1", "chunk-2"]);
  assert.equal(docState.status, "indexed");
});

test("selhání dávky (>1 chunk) degraduje na embedding po jednom", async () => {
  embeddingsOn = true;
  batchSize = 10;
  chunkOverride = [chunk("A", 0), chunk("B", 1), chunk("C", 2)];
  batchShouldFail = () => true;
  extraction = { needsOcr: false, fullText: "x" };

  await processJob("job-1", "doc-1", "index");

  // Dávka se zkusila jednou, pak fallback po jednom pro každý chunk.
  assert.equal(embedBatchCalls.length, 1);
  assert.deepEqual(embedSingleCalls, ["A", "B", "C"]);
  // Úspěšné chunky se přesto zapíšou po pádu dávky.
  assert.deepEqual(embeddingInserts, ["chunk-0", "chunk-1", "chunk-2"]);
  assert.equal(docState.status, "indexed");
  assert.equal(failedViaPool, false);
});

test("selhání u jediného chunku se vyhodí (žádná nekonečná degradace)", async () => {
  embeddingsOn = true;
  batchSize = 1;
  chunkOverride = [chunk("A", 0)];
  batchShouldFail = () => true;
  extraction = { needsOcr: false, fullText: "x" };

  await processJob("job-1", "doc-1", "index");

  // Dávka o jednom chunku padla -> rovnou vyhozeno, žádný fallback po jednom.
  assert.equal(embedBatchCalls.length, 1);
  assert.equal(embedSingleCalls.length, 0);
  assert.deepEqual(embeddingInserts, []);
  // Chyba probublá až do processJob, dokument skončí jako failed.
  assert.equal(docState.status, "failed");
  assert.equal(failedViaPool, true);
});

test("po pádu dávky se zaembeddují i ostatní dávky (izolace selhání)", async () => {
  embeddingsOn = true;
  batchSize = 2;
  chunkOverride = [chunk("A", 0), chunk("B", 1), chunk("C", 2), chunk("D", 3)];
  // Selže jen první dávka (["A","B"]); druhá dávka (["C","D"]) projde.
  batchShouldFail = (texts) => texts.includes("A");
  extraction = { needsOcr: false, fullText: "x" };

  await processJob("job-1", "doc-1", "index");

  // Dvě dávková volání; fallback po jednom jen pro první dávku.
  assert.equal(embedBatchCalls.length, 2);
  assert.deepEqual(embedSingleCalls, ["A", "B"]);
  // Všechny čtyři chunky nakonec zapsané (první dávka přes fallback, druhá přímo).
  assert.deepEqual(embeddingInserts, ["chunk-0", "chunk-1", "chunk-2", "chunk-3"]);
  assert.equal(docState.status, "indexed");
});
