import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { documents, documentVersions, documentTagLinks } from "../db/schema.js";
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
  DuplicateDocumentError,
} from "../documents/document-service.js";
import { getDownloadUrl } from "../storage/s3.js";
import { enqueueDocument } from "../indexing/worker.js";
import { env } from "../env.js";
import { audit } from "../lib/audit.js";
import type { DocumentType, DocumentVisibility } from "../../shared/types.js";

export const documentRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.openai.maxUploadMb * 1024 * 1024 },
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
  if (user.role === "admin") return { ok: true, doc };
  if (doc.visibility === "admin_only") {
    return { ok: false, status: 403, error: "Nedostatečná oprávnění." };
  }
  if (doc.uploadedByUserId !== user.id) {
    return { ok: false, status: 403, error: "Lze upravovat jen vlastní dokumenty." };
  }
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
