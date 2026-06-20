import { z } from "zod";
import {
  DuplicateDocumentError,
  type CreateDocumentInput,
} from "../documents/document-service.js";
import type { DocumentType, DocumentVisibility } from "../../shared/types.js";

// Schéma jedné položky potvrzené dávky (metadata zvolená/upravená adminem).
export const batchItemSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  categoryId: z.string().uuid().optional().or(z.literal("")),
  documentType: z.string().optional(),
  visibility: z.enum(["all_users", "admin_only"]).optional(),
  tagIds: z.array(z.string()).optional(),
  skip: z.boolean().optional(),
});

export type BatchItem = z.infer<typeof batchItemSchema>;

// Minimální tvar nahraného souboru (kompatibilní s Express.Multer.File).
export interface BatchCommitFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

export type BatchCommitStatus = "created" | "skipped" | "duplicate" | "error";

export interface BatchCommitResult {
  fileName: string;
  status: BatchCommitStatus;
  documentId?: string;
  existingDocumentId?: string;
  error?: string;
}

/**
 * Naparsuje a zvaliduje metadata dávky (JSON řetězec z multipart pole).
 * Vynucuje, že počet položek metadat přesně odpovídá počtu souborů — index
 * souborů a položek musí být zarovnaný, jinak by se metadata přiřadila špatně.
 */
export function parseBatchItems(
  itemsJson: string,
  fileCount: number,
): { ok: true; items: BatchItem[] } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(itemsJson);
  } catch {
    return { ok: false, error: "Neplatná metadata dávky." };
  }
  const parsed = z.array(batchItemSchema).safeParse(raw);
  if (!parsed.success || parsed.data.length !== fileCount) {
    return { ok: false, error: "Počet metadat neodpovídá počtu souborů." };
  }
  return { ok: true, items: parsed.data };
}

/**
 * Potvrdí dávku: pro každý soubor (ve stejném pořadí jako metadata) vytvoří
 * dokument přes injektovanou funkci `create`. Každý soubor se zpracuje
 * nezávisle — chyba jednoho souboru (včetně duplicity) NIKDY neshodí zbytek
 * dávky; namapuje se na per-soubor výsledek. `onCreated` umožní volajícímu
 * doplnit vedlejší efekt (např. audit) bez navázání na Express/DB.
 */
export async function commitBatch<TDoc extends { id: string; title: string }>(
  files: BatchCommitFile[],
  items: BatchItem[],
  uploadedByUserId: string,
  create: (input: CreateDocumentInput) => Promise<TDoc>,
  onCreated?: (doc: TDoc) => Promise<void> | void,
): Promise<BatchCommitResult[]> {
  const results: BatchCommitResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const item = items[i];
    const fileName = file.originalname;

    if (item.skip) {
      results.push({ fileName, status: "skipped" });
      continue;
    }

    try {
      const doc = await create({
        buffer: file.buffer,
        originalFileName: fileName,
        mimeType: file.mimetype,
        title: item.title,
        description: item.description,
        categoryId: item.categoryId || null,
        documentType: (item.documentType as DocumentType) || "other",
        visibility: (item.visibility as DocumentVisibility) || "all_users",
        tagIds: item.tagIds,
        uploadedByUserId,
      });
      if (onCreated) await onCreated(doc);
      results.push({ fileName, status: "created", documentId: doc.id });
    } catch (err) {
      if (err instanceof DuplicateDocumentError) {
        results.push({
          fileName,
          status: "duplicate",
          existingDocumentId: err.existingDocumentId,
        });
      } else {
        results.push({
          fileName,
          status: "error",
          error: String((err as Error).message),
        });
      }
    }
  }

  return results;
}
