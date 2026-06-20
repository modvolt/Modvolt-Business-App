import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents } from "../db/schema.js";
import { putObject, deleteObject } from "../storage/s3.js";
import { enqueueDocument } from "../indexing/worker.js";
import type { DocumentType, DocumentVisibility } from "../../shared/types.js";

const ACCEPTED_EXT = /\.(pdf|docx|xlsx|txt|md|markdown|csv)$/i;

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
};

export function isAcceptedDocument(fileName: string): boolean {
  return ACCEPTED_EXT.test(fileName);
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export interface CreateDocumentInput {
  buffer: Buffer;
  originalFileName: string;
  mimeType?: string;
  title?: string;
  description?: string;
  categoryId?: string | null;
  documentType?: DocumentType;
  visibility?: DocumentVisibility;
  sourceName?: string;
  sourceUrl?: string;
  version?: string;
  uploadedByUserId?: string;
}

export async function createDocument(input: CreateDocumentInput) {
  if (!isAcceptedDocument(input.originalFileName)) {
    throw new Error("Nepodporovaný typ souboru.");
  }
  const ext = input.originalFileName.split(".").pop()!.toLowerCase();
  const mimeType = input.mimeType || MIME_BY_EXT[ext] || "application/octet-stream";
  const hash = sha256(input.buffer);
  const objectPath = `documents/${hash.slice(0, 2)}/${hash}.${ext}`;

  await putObject(objectPath, input.buffer, mimeType);

  const [doc] = await db
    .insert(documents)
    .values({
      title: input.title || input.originalFileName.replace(ACCEPTED_EXT, ""),
      description: input.description ?? null,
      categoryId: input.categoryId ?? null,
      documentType: input.documentType ?? "other",
      visibility: input.visibility ?? "all_users",
      sourceName: input.sourceName ?? null,
      sourceUrl: input.sourceUrl ?? null,
      version: input.version ?? null,
      status: "uploaded",
      originalFileName: input.originalFileName,
      mimeType,
      sizeBytes: input.buffer.length,
      sha256Hash: hash,
      objectPath,
      uploadedByUserId: input.uploadedByUserId ?? null,
    })
    .returning();

  await enqueueDocument(doc.id, "index");
  return doc;
}

export async function deleteDocument(documentId: string): Promise<void> {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  const doc = rows[0];
  if (!doc) return;
  try {
    await deleteObject(doc.objectPath);
  } catch {
    // I při selhání úložiště smaž DB záznam (chunky/embeddingy přes FK app-side).
  }
  await db.delete(documents).where(eq(documents.id, documentId));
}
