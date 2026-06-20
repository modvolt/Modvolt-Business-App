import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { logger } from "../lib/logger.js";

export interface ExtractedPage {
  pageNumber: number | null;
  text: string;
}

export interface ExtractionResult {
  pages: ExtractedPage[];
  fullText: string;
  needsOcr: boolean;
}

const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/csv",
]);

export async function extractText(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<ExtractionResult> {
  const lower = fileName.toLowerCase();

  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    return extractPdf(buffer);
  }
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    return extractDocx(buffer);
  }
  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    lower.endsWith(".xlsx")
  ) {
    return extractXlsx(buffer);
  }
  if (
    TEXT_MIMES.has(mimeType) ||
    /\.(txt|md|markdown|csv)$/i.test(lower)
  ) {
    const text = buffer.toString("utf-8");
    return { pages: [{ pageNumber: null, text }], fullText: text, needsOcr: false };
  }

  // Fallback: zkus jako prostý text.
  const text = buffer.toString("utf-8");
  return {
    pages: [{ pageNumber: null, text }],
    fullText: text,
    needsOcr: false,
  };
}

async function extractPdf(buffer: Buffer): Promise<ExtractionResult> {
  try {
    // pdf-parse je CommonJS; dynamický import kvůli ESM.
    const mod = await import("pdf-parse");
    const pdfParse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string; numpages: number }>;
    const data = await pdfParse(buffer);
    const fullText = (data.text ?? "").trim();
    // Heuristika: skenovaný PDF bez textové vrstvy -> needsOcr.
    const needsOcr = fullText.length < 20;
    return {
      pages: [{ pageNumber: null, text: fullText }],
      fullText,
      needsOcr,
    };
  } catch (err) {
    logger.warn("Extrakce PDF selhala", String(err));
    return { pages: [], fullText: "", needsOcr: true };
  }
}

async function extractDocx(buffer: Buffer): Promise<ExtractionResult> {
  const result = await mammoth.extractRawText({ buffer });
  const text = (result.value ?? "").trim();
  return {
    pages: [{ pageNumber: null, text }],
    fullText: text,
    needsOcr: false,
  };
}

async function extractXlsx(buffer: Buffer): Promise<ExtractionResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const parts: string[] = [];
  wb.eachSheet((sheet) => {
    parts.push(`# List: ${sheet.name}`);
    sheet.eachRow((row) => {
      const values = (row.values as unknown[])
        .slice(1)
        .map((v) => (v == null ? "" : String(v)));
      parts.push(values.join("\t"));
    });
  });
  const text = parts.join("\n").trim();
  return {
    pages: [{ pageNumber: null, text }],
    fullText: text,
    needsOcr: false,
  };
}
