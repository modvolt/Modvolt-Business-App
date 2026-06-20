import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  documents,
  documentVersions,
  documentTagLinks,
  documentCategories,
  documentTags,
} from "../db/schema.js";
import { asc } from "drizzle-orm";
import {
  requireAuth,
  requireRole,
  requireWriteAccess,
} from "../middleware/auth.js";
import {
  createDocument,
  deleteDocument,
  setDocumentTags,
  getDocumentTagIds,
  findDocumentByHash,
  isAcceptedDocument,
  isZipFile,
  expandZip,
  sha256,
  DuplicateDocumentError,
} from "../documents/document-service.js";
import { extractText } from "../documents/text-extraction.js";
import {
  classifyDocument,
  classificationAvailable,
} from "../ai/classification-service.js";
import { authorizeDocumentWrite } from "./document-access.js";
import { parseBatchItems, commitBatch } from "./batch-commit.js";
import { getDownloadUrl, getObjectBuffer } from "../storage/s3.js";
import { enqueueDocument } from "../indexing/worker.js";
import { env } from "../env.js";
import { audit } from "../lib/audit.js";
import type { DocumentType, DocumentVisibility } from "../../shared/types.js";

export const documentRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.openai.maxUploadMb * 1024 * 1024 },
});

// Hromadný import: více souborů najednou (limit počtu kvůli paměti).
const MAX_BATCH_FILES = 50;
const MAX_ENTRY_BYTES = env.openai.maxUploadMb * 1024 * 1024;
const batchUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ENTRY_BYTES,
    files: MAX_BATCH_FILES,
  },
});

// ZIP archiv může být výrazně větší než jeden dokument (sbalí celou složku),
// proto vlastní, velkorysejší limit. Jednotlivé položky uvnitř se kontrolují
// proti MAX_ENTRY_BYTES až při rozbalení.
const zipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ENTRY_BYTES * 5 },
});

documentRouter.use(requireAuth);

// Ověří, že přihlášený uživatel smí daný dokument měnit.
// Admin smí vše; ostatní jen vlastní dokumenty s viditelností all_users.
async function loadDocumentForWrite(
  id: string,
  user: { id: string; role: string },
): Promise<
  | { ok: true; doc: typeof documents.$inferSelect }
  | { ok: false; status: number; error: string }
> {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, id))
    .limit(1);
  const doc = rows[0];
  if (!doc) return { ok: false, status: 404, error: "Dokument nenalezen." };
  const decision = authorizeDocumentWrite(doc, user);
  if (!decision.ok) return decision;
  return { ok: true, doc };
}

// Seznam dokumentů s filtrováním.
documentRouter.get("/", async (req, res) => {
  const q = (req.query.q as string) || "";
  const categoryId = (req.query.categoryId as string) || "";
  const status = (req.query.status as string) || "";
  const isAdmin = req.currentUser!.role === "admin";

  const conditions = [];
  if (!isAdmin) conditions.push(eq(documents.visibility, "all_users"));
  if (q) conditions.push(ilike(documents.title, `%${q}%`));
  if (categoryId) conditions.push(eq(documents.categoryId, categoryId));
  if (status) conditions.push(eq(documents.status, status));

  const rows = await db
    .select()
    .from(documents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(documents.createdAt))
    .limit(200);

  // Doplnění štítků (ID) ke každému dokumentu jedním dotazem.
  const tagsByDoc = new Map<string, string[]>();
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const links = await db
      .select({ documentId: documentTagLinks.documentId, tagId: documentTagLinks.tagId })
      .from(documentTagLinks)
      .where(inArray(documentTagLinks.documentId, ids));
    for (const l of links) {
      const arr = tagsByDoc.get(l.documentId) ?? [];
      arr.push(l.tagId);
      tagsByDoc.set(l.documentId, arr);
    }
  }

  res.json({
    documents: rows.map((r) => ({ ...r, tagIds: tagsByDoc.get(r.id) ?? [] })),
  });
});

documentRouter.get("/:id", async (req, res) => {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, req.params.id))
    .limit(1);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: "Dokument nenalezen." });
  if (doc.visibility === "admin_only" && req.currentUser!.role !== "admin") {
    return res.status(403).json({ error: "Nedostatečná oprávnění." });
  }
  res.json({ document: doc, tagIds: await getDocumentTagIds(doc.id) });
});

// Stažení přes krátkodobé předpodepsané URL (privátní bucket).
documentRouter.get("/:id/download", async (req, res) => {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, req.params.id))
    .limit(1);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: "Dokument nenalezen." });
  if (doc.visibility === "admin_only" && req.currentUser!.role !== "admin") {
    return res.status(403).json({ error: "Nedostatečná oprávnění." });
  }
  try {
    const url = await getDownloadUrl(doc.objectPath, 300);
    await audit(req, "download", "document", doc.id);
    res.json({ url });
  } catch {
    res.status(503).json({ error: "Úložiště není dostupné." });
  }
});

// V multipart/form-data přicházejí pole jako řetězce; tagIds může být JSON pole
// nebo opakované pole. Tento coerce je sjednotí na string[].
const tagIdsSchema = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v.filter(Boolean);
    const s = v.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // padá zpět na CSV
    }
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  });

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Očekáván formát YYYY-MM-DD")
  .optional()
  .or(z.literal(""));

// Pole metadat společná pro upload i úpravu (odpovídají sloupcům documents).
const metadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  categoryId: z.string().uuid().optional().or(z.literal("")),
  documentType: z.string().optional(),
  visibility: z.enum(["all_users", "admin_only"]).optional(),
  sourceName: z.string().optional(),
  sourceUrl: z.string().optional(),
  version: z.string().optional(),
  validFrom: dateSchema,
  validTo: dateSchema,
  tagIds: tagIdsSchema,
});

// Upload navíc umožní vytvořit novou verzi existujícího dokumentu.
const uploadSchema = metadataSchema.extend({
  replaceDocumentId: z.string().uuid().optional(),
  changeNote: z.string().optional(),
});

// Nahrání dokumentu (admin nebo user dle oprávnění).
documentRouter.post(
  "/",
  requireWriteAccess,
  upload.single("file"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Chybí soubor." });
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Neplatná metadata dokumentu." });
    }
    // Nová verze existujícího dokumentu vyžaduje oprávnění na cílový dokument.
    if (parsed.data.replaceDocumentId) {
      const access = await loadDocumentForWrite(
        parsed.data.replaceDocumentId,
        req.currentUser!,
      );
      if (!access.ok)
        return res.status(access.status).json({ error: access.error });
    }
    try {
      const doc = await createDocument({
        buffer: req.file.buffer,
        originalFileName: req.file.originalname,
        mimeType: req.file.mimetype,
        title: parsed.data.title,
        description: parsed.data.description,
        categoryId: parsed.data.categoryId || null,
        documentType: (parsed.data.documentType as DocumentType) || "other",
        visibility: (parsed.data.visibility as DocumentVisibility) || "all_users",
        sourceName: parsed.data.sourceName,
        sourceUrl: parsed.data.sourceUrl,
        version: parsed.data.version,
        validFrom: parsed.data.validFrom ? new Date(parsed.data.validFrom) : null,
        validTo: parsed.data.validTo ? new Date(parsed.data.validTo) : null,
        tagIds: parsed.data.tagIds,
        replaceDocumentId: parsed.data.replaceDocumentId,
        changeNote: parsed.data.changeNote,
        uploadedByUserId: req.currentUser!.id,
      });
      const action = parsed.data.replaceDocumentId ? "new_version" : "upload";
      await audit(req, action, "document", doc.id, { title: doc.title });
      res.status(201).json({ document: doc });
    } catch (err) {
      if (err instanceof DuplicateDocumentError) {
        return res.status(409).json({
          error: err.message,
          existingDocumentId: err.existingDocumentId,
        });
      }
      res.status(400).json({ error: String((err as Error).message) });
    }
  },
);

// Načte kanonické kategorie a štítky pro klasifikaci (id + název).
async function loadClassificationOptions() {
  const [cats, tgs] = await Promise.all([
    db
      .select({ id: documentCategories.id, name: documentCategories.name })
      .from(documentCategories)
      .orderBy(asc(documentCategories.name)),
    db
      .select({ id: documentTags.id, name: documentTags.name })
      .from(documentTags)
      .orderBy(asc(documentTags.name)),
  ]);
  return { categories: cats, tags: tgs };
}

// (0) Rozbalení ZIP: admin nahraje jeden .zip se složkou dokumentů. Server jej
// rozbalí, vyfiltruje přijatelné typy a vrátí obsah jednotlivých souborů
// (base64). Klient z nich vytvoří soubory a pošle je do beze změny stejného
// analyze/commit flow. Nepodporované/příliš velké položky vrací jako přeskočené.
documentRouter.post(
  "/batch/zip",
  requireWriteAccess,
  zipUpload.single("file"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Chybí ZIP soubor." });
    if (!isZipFile(req.file.originalname)) {
      return res
        .status(400)
        .json({ error: "Nahrajte archiv ve formátu .zip." });
    }

    let expanded;
    try {
      expanded = expandZip(req.file.buffer, {
        maxEntryBytes: MAX_ENTRY_BYTES,
        maxFiles: MAX_BATCH_FILES,
      });
    } catch {
      return res
        .status(400)
        .json({ error: "ZIP archiv se nepodařilo otevřít." });
    }

    if (!expanded.files.length && !expanded.skipped.length) {
      return res
        .status(400)
        .json({ error: "ZIP archiv neobsahuje žádné soubory." });
    }

    await audit(req, "zip_expand", "document", undefined, {
      archive: req.file.originalname,
      accepted: expanded.files.length,
      skipped: expanded.skipped.length,
    });

    res.json({
      files: expanded.files.map((f) => ({
        fileName: f.fileName,
        sizeBytes: f.buffer.length,
        contentBase64: f.buffer.toString("base64"),
      })),
      skipped: expanded.skipped,
    });
  },
);

// (a) Hromadná analýza: přijme více souborů, extrahuje text, vrátí pro každý
// soubor AI návrh klasifikace + detekci duplicit. Každý soubor se zpracuje
// nezávisle, jedna chyba neshodí celou dávku.
documentRouter.post(
  "/batch/analyze",
  requireWriteAccess,
  batchUpload.array("files", MAX_BATCH_FILES),
  async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) return res.status(400).json({ error: "Chybí soubory." });

    const aiEnabled = classificationAvailable();
    const { categories, tags } = await loadClassificationOptions();

    const results = await Promise.all(
      files.map(async (file) => {
        const fileName = file.originalname;
        const sizeBytes = file.size;
        const fallbackTitle = fileName.replace(/\.[^.]+$/, "");
        const base = {
          fileName,
          sizeBytes,
          documentType: "other" as DocumentType,
          categoryId: null as string | null,
          tagIds: [] as string[],
          title: fallbackTitle,
          description: "",
          aiClassified: false,
          duplicate: null as { id: string; title: string } | null,
          error: null as string | null,
        };

        if (!isAcceptedDocument(fileName)) {
          return { ...base, error: "Nepodporovaný typ souboru." };
        }

        // Detekce duplicit podle SHA-256 vůči existujícím dokumentům.
        const hash = sha256(file.buffer);
        const existing = await findDocumentByHash(hash);
        const duplicate = existing
          ? { id: existing.id, title: existing.title }
          : null;

        // Bez AI vracíme rozumné výchozí hodnoty (admin doplní ručně).
        if (!aiEnabled) {
          return { ...base, duplicate };
        }

        try {
          const extracted = await extractText(
            file.buffer,
            file.mimetype,
            fileName,
          );
          const suggestion = await classifyDocument({
            text: extracted.fullText,
            fileName,
            categories,
            tags,
          });
          if (!suggestion) {
            return { ...base, duplicate };
          }
          return {
            ...base,
            documentType: suggestion.documentType,
            categoryId: suggestion.categoryId,
            tagIds: suggestion.tagIds,
            title: suggestion.title || fallbackTitle,
            description: suggestion.description,
            aiClassified: true,
            duplicate,
          };
        } catch (err) {
          // Selhání jednoho souboru nesmí shodit zbytek dávky.
          return {
            ...base,
            duplicate,
            error: `Analýza selhala: ${String((err as Error).message)}`,
          };
        }
      }),
    );

    res.json({ aiEnabled, results });
  },
);

// (b) Potvrzení dávky: přijme soubory + odpovídající metadata (ve stejném
// pořadí) a každý soubor vytvoří přes existující pipeline createDocument.
// Každý soubor se zpracuje nezávisle; výsledek je per-soubor. Vlastní logika
// (validace, izolace souborů, mapování duplicit) žije v batch-commit.ts.
documentRouter.post(
  "/batch/commit",
  requireWriteAccess,
  batchUpload.array("files", MAX_BATCH_FILES),
  async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) return res.status(400).json({ error: "Chybí soubory." });

    const parsed = parseBatchItems(String(req.body.items ?? "[]"), files.length);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const results = await commitBatch(
      files,
      parsed.items,
      req.currentUser!.id,
      createDocument,
      (doc) =>
        audit(req, "upload", "document", doc.id, {
          title: doc.title,
          batch: true,
        }),
    );

    res.status(201).json({ results });
  },
);

// Maximální počet dokumentů v jedné dávce přeřazení (ochrana paměti/času).
const MAX_RECLASSIFY = 50;

const reclassifyAnalyzeSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(MAX_RECLASSIFY),
});

// (a) Hromadné přeřazení – analýza: pro vybrané EXISTUJÍCÍ dokumenty stáhne
// uložený soubor, extrahuje text a vrátí AI návrh klasifikace vedle stávajících
// metadat. Každý dokument se zpracuje nezávisle, jedna chyba neshodí dávku.
documentRouter.post("/reclassify/analyze", requireWriteAccess, async (req, res) => {
  const parsed = reclassifyAnalyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Neplatný seznam dokumentů." });
  }

  const aiEnabled = classificationAvailable();
  const { categories, tags } = await loadClassificationOptions();

  const results = await Promise.all(
    parsed.data.documentIds.map(async (documentId) => {
      const base = {
        documentId,
        fileName: "",
        current: null as null | {
          title: string;
          description: string;
          documentType: DocumentType;
          categoryId: string | null;
          tagIds: string[];
        },
        suggestion: null as null | {
          title: string;
          description: string;
          documentType: DocumentType;
          categoryId: string | null;
          tagIds: string[];
        },
        aiClassified: false,
        error: null as string | null,
      };

      const access = await loadDocumentForWrite(documentId, req.currentUser!);
      if (!access.ok) {
        return { ...base, error: access.error };
      }
      const doc = access.doc;
      const currentTagIds = await getDocumentTagIds(doc.id);
      const current = {
        title: doc.title,
        description: doc.description ?? "",
        documentType: doc.documentType as DocumentType,
        categoryId: doc.categoryId,
        tagIds: currentTagIds,
      };
      const withCurrent = { ...base, fileName: doc.originalFileName, current };

      if (!aiEnabled) {
        return withCurrent;
      }

      try {
        const buffer = await getObjectBuffer(doc.objectPath);
        const extracted = await extractText(buffer, doc.mimeType, doc.originalFileName);
        const suggestion = await classifyDocument({
          text: extracted.fullText,
          fileName: doc.originalFileName,
          categories,
          tags,
        });
        if (!suggestion) {
          return withCurrent;
        }
        return {
          ...withCurrent,
          suggestion: {
            title: suggestion.title || doc.title,
            description: suggestion.description,
            documentType: suggestion.documentType,
            categoryId: suggestion.categoryId,
            tagIds: suggestion.tagIds,
          },
          aiClassified: true,
        };
      } catch (err) {
        return {
          ...withCurrent,
          error: `Analýza selhala: ${String((err as Error).message)}`,
        };
      }
    }),
  );

  res.json({ aiEnabled, results });
});

// Schéma jedné potvrzené položky přeřazení (metadata zvolená/upravená adminem).
const reclassifyItemSchema = z.object({
  documentId: z.string().uuid(),
  title: z.string().optional(),
  description: z.string().optional(),
  categoryId: z.string().uuid().optional().or(z.literal("")),
  documentType: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
  skip: z.boolean().optional(),
});

const reclassifyCommitSchema = z.object({
  items: z.array(reclassifyItemSchema).min(1).max(MAX_RECLASSIFY),
});

// (b) Hromadné přeřazení – potvrzení: aktualizuje metadata vybraných dokumentů.
// Každý dokument se zpracuje nezávisle; jedna chyba neshodí zbytek dávky.
// Obsah souboru se nemění, vyhledávání čte typ/název přes JOIN živě, takže
// reindex není nutný – znovu zařadíme jen dokumenty, které ještě nejsou
// zaindexované, aby se dostaly do fronty.
documentRouter.post("/reclassify/commit", requireWriteAccess, async (req, res) => {
  const parsed = reclassifyCommitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Neplatná metadata přeřazení." });
  }

  const results: {
    documentId: string;
    status: "updated" | "skipped" | "error";
    error?: string;
  }[] = [];

  for (const item of parsed.data.items) {
    if (item.skip) {
      results.push({ documentId: item.documentId, status: "skipped" });
      continue;
    }
    try {
      const access = await loadDocumentForWrite(item.documentId, req.currentUser!);
      if (!access.ok) {
        results.push({
          documentId: item.documentId,
          status: "error",
          error: access.error,
        });
        continue;
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (item.title !== undefined) updates.title = item.title;
      if (item.description !== undefined) updates.description = item.description;
      if (item.documentType !== undefined) updates.documentType = item.documentType;
      if (item.categoryId !== undefined) {
        updates.categoryId = item.categoryId === "" ? null : item.categoryId;
      }

      const [doc] = await db
        .update(documents)
        .set(updates)
        .where(eq(documents.id, item.documentId))
        .returning();
      if (!doc) {
        results.push({
          documentId: item.documentId,
          status: "error",
          error: "Dokument nenalezen.",
        });
        continue;
      }
      if (item.tagIds !== undefined) {
        await setDocumentTags(doc.id, item.tagIds);
      }
      // Reindex jen pokud dokument ještě není zaindexovaný (obsah se nemění).
      if (doc.status !== "indexed") {
        await enqueueDocument(doc.id, "reindex");
      }
      await audit(req, "reclassify", "document", doc.id, { title: doc.title });
      results.push({ documentId: item.documentId, status: "updated" });
    } catch (err) {
      results.push({
        documentId: item.documentId,
        status: "error",
        error: String((err as Error).message),
      });
    }
  }

  res.status(200).json({ results });
});

// Historie verzí dokumentu.
documentRouter.get("/:id/versions", async (req, res) => {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, req.params.id))
    .limit(1);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: "Dokument nenalezen." });
  if (doc.visibility === "admin_only" && req.currentUser!.role !== "admin") {
    return res.status(403).json({ error: "Nedostatečná oprávnění." });
  }
  const versions = await db
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.documentId, req.params.id))
    .orderBy(desc(documentVersions.createdAt));
  res.json({ versions });
});

// Aktualizace metadat.
documentRouter.patch("/:id", requireWriteAccess, async (req, res) => {
  const access = await loadDocumentForWrite(req.params.id, req.currentUser!);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const parsed = metadataSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Neplatná metadata." });
  }
  const { tagIds, validFrom, validTo, ...rest } = parsed.data;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    if (k === "categoryId") {
      updates.categoryId = v === "" ? null : v;
    } else {
      updates[k] = v;
    }
  }
  if (validFrom !== undefined) {
    updates.validFrom = validFrom ? new Date(validFrom) : null;
  }
  if (validTo !== undefined) {
    updates.validTo = validTo ? new Date(validTo) : null;
  }
  const [doc] = await db
    .update(documents)
    .set(updates)
    .where(eq(documents.id, req.params.id))
    .returning();
  if (!doc) return res.status(404).json({ error: "Dokument nenalezen." });
  if (tagIds !== undefined) {
    await setDocumentTags(doc.id, tagIds);
  }
  await audit(req, "update", "document", doc.id);
  res.json({ document: doc, tagIds: await getDocumentTagIds(doc.id) });
});

// Znovu zaindexovat.
documentRouter.post("/:id/reindex", requireWriteAccess, async (req, res) => {
  const access = await loadDocumentForWrite(req.params.id, req.currentUser!);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  await enqueueDocument(req.params.id, "reindex");
  await audit(req, "reindex", "document", req.params.id);
  res.json({ ok: true });
});

// Smazání (jen admin).
documentRouter.delete("/:id", requireRole("admin"), async (req, res) => {
  await deleteDocument(req.params.id);
  await audit(req, "delete", "document", req.params.id);
  res.json({ ok: true });
});
