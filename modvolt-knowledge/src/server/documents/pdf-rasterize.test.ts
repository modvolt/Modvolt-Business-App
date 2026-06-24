import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { rasterizePdf } from "./pdf-rasterize.js";

// Minimální validní jednostránkové PDF (text "Ahoj OCR"). Slouží jako reálný
// vstup pro PDFium WASM render -> sharp JPEG, bez systémových knihoven.
const MINIMAL_PDF =
  "%PDF-1.4\n" +
  "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
  "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
  "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] " +
  "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n" +
  "4 0 obj\n<< /Length 44 >>\nstream\n" +
  "BT /F1 24 Tf 40 100 Td (Ahoj OCR) Tj ET\n" +
  "endstream\nendobj\n" +
  "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n" +
  "trailer\n<< /Root 1 0 R >>\n%%EOF";

function pdfBuffer(): Buffer {
  return Buffer.from(MINIMAL_PDF, "latin1");
}

test("rasterizePdf vykreslí stránku na validní JPEG", async () => {
  const { pages, totalPages } = await rasterizePdf(pdfBuffer(), 10);
  assert.equal(totalPages, 1);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageNumber, 1);
  const meta = await sharp(pages[0].jpeg).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok((meta.width ?? 0) > 0);
  assert.ok((meta.height ?? 0) > 0);
});

test("rasterizePdf respektuje limit stran", async () => {
  const { pages, totalPages } = await rasterizePdf(pdfBuffer(), 1);
  assert.equal(totalPages, 1);
  assert.equal(pages.length, 1);
});
