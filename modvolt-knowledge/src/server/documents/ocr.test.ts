import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Stav řízený mocky níže. Module mocking umožní testovat ocrPdf bez reálného
// PDFium renderu i bez OpenAI účtu.
let ocrUsable = true;
let rasterPages: { pageNumber: number; jpeg: Buffer }[] = [];
let rasterTotalPages = 0;
let rasterizeCalls: number[] = [];
// Mapuje číslo stránky -> odpověď (string) nebo Error (vyhozeno).
let visionByPage: Record<number, string | Error> = {};
let visionCalls = 0;

mock.module("../env.js", {
  namedExports: {
    env: { openai: { ocrMaxPages: 5 } },
    isOcrUsable: () => ocrUsable,
  },
});

mock.module("./pdf-rasterize.js", {
  namedExports: {
    rasterizePdf: async (_buffer: Buffer, maxPages: number) => {
      rasterizeCalls.push(maxPages);
      return { pages: rasterPages, totalPages: rasterTotalPages };
    },
  },
});

mock.module("./image-processing.js", {
  namedExports: {
    imageToDataUrl: (buf: Buffer) => `data:image/jpeg;base64,${buf.toString("base64")}`,
  },
});

mock.module("../ai/openai-responses.js", {
  namedExports: {
    createVisionResponse: async (params: { imageDataUrl: string }) => {
      visionCalls += 1;
      // Page number is encoded as the base64 of "p<N>" in the fake jpeg buffer.
      const decoded = Buffer.from(
        params.imageDataUrl.split(",")[1] ?? "",
        "base64",
      ).toString();
      const pageNumber = Number(decoded.replace("p", ""));
      const resp = visionByPage[pageNumber];
      if (resp instanceof Error) throw resp;
      return resp ?? "";
    },
  },
});

const { ocrPdf, ocrAvailable } = await import("./ocr.js");

function fakePages(n: number) {
  rasterPages = Array.from({ length: n }, (_, i) => ({
    pageNumber: i + 1,
    jpeg: Buffer.from(`p${i + 1}`),
  }));
  rasterTotalPages = n;
}

beforeEach(() => {
  ocrUsable = true;
  rasterPages = [];
  rasterTotalPages = 0;
  rasterizeCalls = [];
  visionByPage = {};
  visionCalls = 0;
});

test("ocrAvailable odráží isOcrUsable", () => {
  ocrUsable = true;
  assert.equal(ocrAvailable(), true);
  ocrUsable = false;
  assert.equal(ocrAvailable(), false);
});

test("ocrPdf spojí přepsaný text stránek oddělovačem", async () => {
  fakePages(2);
  visionByPage = { 1: "Strana jedna", 2: "Strana dvě" };
  const res = await ocrPdf(Buffer.from("pdf"));
  assert.equal(res.fullText, "Strana jedna\n\nStrana dvě");
  assert.equal(res.pageCount, 2);
  assert.equal(res.truncated, false);
});

test("ocrPdf přeskočí stránky s prázdným přepisem", async () => {
  fakePages(3);
  visionByPage = { 1: "Text", 2: "   ", 3: "Další" };
  const res = await ocrPdf(Buffer.from("pdf"));
  assert.equal(res.fullText, "Text\n\nDalší");
  assert.equal(res.pageCount, 2);
});

test("ocrPdf izoluje chybu jedné stránky", async () => {
  fakePages(3);
  visionByPage = {
    1: "Ok jedna",
    2: new Error("vision selhalo"),
    3: "Ok tři",
  };
  const res = await ocrPdf(Buffer.from("pdf"));
  assert.equal(res.fullText, "Ok jedna\n\nOk tři");
  assert.equal(res.pageCount, 2);
  assert.equal(visionCalls, 3);
});

test("ocrPdf předá limit stran do rasterizace a hlásí oříznutí", async () => {
  // Rasterizace vrátí jen 2 stránky, ale dokument jich má 10 -> truncated.
  rasterPages = [
    { pageNumber: 1, jpeg: Buffer.from("p1") },
    { pageNumber: 2, jpeg: Buffer.from("p2") },
  ];
  rasterTotalPages = 10;
  visionByPage = { 1: "A", 2: "B" };
  const res = await ocrPdf(Buffer.from("pdf"));
  assert.deepEqual(rasterizeCalls, [5]);
  assert.equal(res.truncated, true);
  assert.equal(res.pageCount, 2);
});

test("ocrPdf vrátí prázdný text, když žádná stránka nedá text", async () => {
  fakePages(2);
  visionByPage = { 1: "", 2: "" };
  const res = await ocrPdf(Buffer.from("pdf"));
  assert.equal(res.fullText, "");
  assert.equal(res.pageCount, 0);
});
