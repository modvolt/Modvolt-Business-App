import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  documents,
  documentVersions,
  documentChunks,
  documentTagLinks,
} from "../db/schema.js";
import { putObject, deleteObject } from "../storage/s3.js";
import { enqueueDocument } from "../indexing/worker.js";
import type { DocumentType, DocumentVisibility } from "../../shared/types.js";

/** Chyba duplicity podle SHA-256 (stejný soubor už v databázi existuje). */
export class DuplicateDocumentError extends Error {
  constructor(
    public existingDocumentId: string,
    public existingTitle: string,
  ) {
    super(
      `Tento soubor už v databázi existuje (duplicita podle SHA-256): "${existingTitle}".`,
    );
    this.name = "DuplicateDocumentError";
  }
}

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
  validFrom?: Date | null;
  validTo?: Date | null;
  /** Štítky (ID) k navázání na dokument. */
  tagIds?: string[];
  uploadedByUserId?: string;
  /** Pokud je nastaveno, nahraje se nová verze existujícího dokumentu. */
  replaceDocumentId?: string;
  /** Poznámka ke změně (uloží se k archivované verzi). */
  changeNote?: string;
}

/** Vrátí existující dokument se stejným SHA-256, pokud existuje. */
export async function findDocumentByHash(hash: string) {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.sha256Hash, hash))
    .limit(1);
  return rows[0] ?? null;
}

export async function createDocument(input: CreateDocumentInput) {
  if (!isAcceptedDocument(input.originalFileName)) {
    throw new Error("Nepodporovaný typ souboru.");
  }
  const ext = input.originalFileName.split(".").pop()!.toLowerCase();
  const mimeType = input.mimeType || MIME_BY_EXT[ext] || "application/octet-stream";
  const hash = sha256(input.buffer);
  const objectPath = `documents/${hash.slice(0, 2)}/${hash}.${ext}`;

  // Nová verze existujícího dokumentu.
  if (input.replaceDocumentId) {
    return replaceDocument(input, { ext, mimeType, hash, objectPath });
  }

  // Detekce duplicit podle SHA-256: stejný soubor nepřijímáme znovu.
  const existing = await findDocumentByHash(hash);
  if (existing) {
    throw new DuplicateDocumentError(existing.id, existing.title);
  }

  await putObject(objectPath, input.buffer, mimeType);

  let doc;
  try {
    [doc] = await db
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
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        status: "uploaded",
        originalFileName: input.originalFileName,
        mimeType,
        sizeBytes: input.buffer.length,
        sha256Hash: hash,
        objectPath,
        uploadedByUserId: input.uploadedByUserId ?? null,
      })
      .returning();
  } catch (err) {
    // Souběžné nahrání stejného souboru: unikátní index na sha256 zachytí duplicitu.
    if (isUniqueViolation(err)) {
      const dup = await findDocumentByHash(hash);
      throw new DuplicateDocumentError(dup?.id ?? "", dup?.title ?? "");
    }
    throw err;
  }

  if (input.tagIds) {
    await setDocumentTags(doc.id, input.tagIds);
  }

  await enqueueDocument(doc.id, "index");
  return doc;
}

/** Přepíše navázané štítky dokumentu na zadaný seznam ID. */
export async function setDocumentTags(
  documentId: string,
  tagIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(documentTagLinks)
      .where(eq(documentTagLinks.documentId, documentId));
    const unique = Array.from(new Set(tagIds.filter(Boolean)));
    if (unique.length) {
      await tx
        .insert(documentTagLinks)
        .values(unique.map((tagId) => ({ documentId, tagId })))
        .onConflictDoNothing();
    }
  });
}

/** Vrátí ID štítků navázaných na dokument. */
export async function getDocumentTagIds(documentId: string): Promise<string[]> {
  const rows = await db
    .select({ tagId: documentTagLinks.tagId })
    .from(documentTagLinks)
    .where(eq(documentTagLinks.documentId, documentId));
  return rows.map((r) => r.tagId);
}

/** Rozpozná porušení unikátního omezení (PostgreSQL kód 23505). */
function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505");
}

/**
 * Nahraje novou verzi existujícího dokumentu: aktuální soubor archivuje do
 * document_versions, aktualizuje záznam dokumentu novým souborem, označí staré
 * chunky jako neaktuální a znovu zaindexuje.
 */
async function replaceDocument(
  input: CreateDocumentInput,
  meta: { ext: string; mimeType: string; hash: string; objectPath: string },
) {
  const current = await db
    .select()
    .from(documents)
    .where(eq(documents.id, input.replaceDocumentId!))
    .limit(1);
  const doc = current[0];
  if (!doc) throw new Error("Dokument k aktualizaci nebyl nalezen.");

  // Beze změny obsahu nemá verzování smysl.
  if (doc.sha256Hash === meta.hash) {
    throw new DuplicateDocumentError(doc.id, doc.title);
  }

  await putObject(meta.objectPath, input.buffer, meta.mimeType);

  // Archivace + aktualizace probíhají v transakci, aby nedošlo k nekonzistenci.
  let updated;
  try {
    updated = await db.transaction(async (tx) => {
      // Spočítej pořadí verze pro štítek.
      const [{ cnt }] = await tx
        .select({ cnt: sql<number>`count(*)::int` })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id));
      const versionLabel = doc.version ?? `v${(cnt ?? 0) + 1}`;

      // Archivuj aktuální (předchozí) soubor jako verzi.
      await tx.insert(documentVersions).values({
        documentId: doc.id,
        versionLabel,
        originalFileName: doc.originalFileName,
        objectPath: doc.objectPath,
        sha256Hash: doc.sha256Hash,
        sizeBytes: doc.sizeBytes,
        changeNote: input.changeNote ?? null,
        uploadedByUserId: input.uploadedByUserId ?? null,
      });

      // Stávající chunky přestávají být aktuální (reindex vytvoří nové).
      await tx
        .update(documentChunks)
        .set({ isCurrent: false })
        .where(
          and(
            eq(documentChunks.documentId, doc.id),
            eq(documentChunks.isCurrent, true),
          ),
        );

      const [row] = await tx
        .update(documents)
        .set({
          title: input.title ?? doc.title,
          description: input.description ?? doc.description,
          categoryId: input.categoryId ?? doc.categoryId,
          documentType: input.documentType ?? doc.documentType,
          visibility: input.visibility ?? doc.visibility,
          sourceName: input.sourceName ?? doc.sourceName,
          sourceUrl: input.sourceUrl ?? doc.sourceUrl,
          version: input.version ?? doc.version,
          status: "uploaded",
          originalFileName: input.originalFileName,
          mimeType: meta.mimeType,
          sizeBytes: input.buffer.length,
          sha256Hash: meta.hash,
          objectPath: meta.objectPath,
          textExtracted: false,
          indexedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, doc.id))
        .returning();
      return row;
    });
  } catch (err) {
    // Nový obsah koliduje s jiným existujícím dokumentem (unikátní sha256).
    if (isUniqueViolation(err)) {
      const dup = await findDocumentByHash(meta.hash);
      throw new DuplicateDocumentError(dup?.id ?? "", dup?.title ?? "");
    }
    throw err;
  }

  await enqueueDocument(updated.id, "reindex");
  return updated;
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
