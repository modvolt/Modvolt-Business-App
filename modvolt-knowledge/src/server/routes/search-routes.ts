import { Router } from "express";
import crypto from "node:crypto";
import multer from "multer";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { searchQueries, chatAttachments } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { searchChunks } from "../search/search-service.js";
import { ask, aiChatAvailable } from "../ai/chat-service.js";
import { processImage } from "../documents/image-processing.js";
import { visionAvailable } from "../ai/vision-analysis.js";
import { putObject, getObjectBuffer } from "../storage/s3.js";
import { isS3Configured, env } from "../env.js";
import { audit } from "../lib/audit.js";
import type { SourceMode } from "../../shared/types.js";

const ACCEPTED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export const searchRouter = Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.image.maxUploadMb * 1024 * 1024 },
});

searchRouter.use(requireAuth);

// Klasické fulltext/vektorové vyhledávání (bez AI).
const searchSchema = z.object({
  query: z.string().min(1),
  sourceMode: z
    .enum(["internal_only", "internal_then_web", "web_allowed", "csn_only"])
    .optional(),
});

searchRouter.post("/search", async (req, res) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Neplatný dotaz." });
  const isAdmin = req.currentUser!.role === "admin";
  const hits = await searchChunks(parsed.data.query, {
    limit: 20,
    sourceMode: (parsed.data.sourceMode as SourceMode) || "internal_only",
    includeAdminOnly: isAdmin,
  });
  await db.insert(searchQueries).values({
    userId: req.currentUser!.id,
    query: parsed.data.query,
    mode: "search",
    sourceMode: parsed.data.sourceMode ?? "internal_only",
    resultCount: hits.length,
  });
  res.json({ hits });
});

// AI chat (volitelně s fotografiemi).
const askSchema = z.object({
  query: z.string().min(1),
  sourceMode: z
    .enum(["internal_only", "internal_then_web", "web_allowed", "csn_only"])
    .optional(),
  promptVersion: z.string().optional(),
});

searchRouter.post("/ask", imageUpload.array("images", 4), async (req, res) => {
  if (!aiChatAvailable()) {
    return res.status(503).json({
      error: "AI chat není dostupný. OpenAI je vypnuto nebo není nastaven klíč.",
    });
  }
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Neplatný dotaz." });

  const files = (req.files as Express.Multer.File[]) || [];
  if (files.length > 0 && !visionAvailable()) {
    return res.status(503).json({
      error: "Analýza fotografií není dostupná (vize je vypnutá).",
    });
  }
  for (const f of files) {
    if (!ACCEPTED_IMAGE_MIME.has(f.mimetype.toLowerCase())) {
      return res.status(400).json({
        error: `Nepodporovaný typ obrázku: ${f.mimetype}.`,
      });
    }
  }

  // 1) Validace + EXIF strip + (volitelně) uložení do privátního S3.
  const imageBuffers: Buffer[] = [];
  const attachmentIds: string[] = [];
  try {
    for (const f of files) {
      const processed = await processImage(f.buffer);
      imageBuffers.push(processed.buffer);

      if (isS3Configured()) {
        const hash = crypto
          .createHash("sha256")
          .update(processed.buffer)
          .digest("hex");
        const objectPath = `attachments/${hash.slice(0, 2)}/${hash}.jpg`;
        await putObject(objectPath, processed.buffer, processed.mimeType);
        const [att] = await db
          .insert(chatAttachments)
          .values({
            uploadedByUserId: req.currentUser!.id,
            attachmentType: "image",
            originalFileName: f.originalname,
            mimeType: processed.mimeType,
            sizeBytes: processed.buffer.length,
            sha256Hash: hash,
            objectPath,
            width: processed.width,
            height: processed.height,
            exifRemoved: processed.exifRemoved,
          })
          .returning();
        attachmentIds.push(att.id);
      }
    }
  } catch (err) {
    return res.status(503).json({
      error: `Zpracování nebo uložení fotografie selhalo: ${String(
        (err as Error).message,
      )}`,
    });
  }

  try {
    const result = await ask({
      query: parsed.data.query,
      requestedSourceMode: (parsed.data.sourceMode as SourceMode) || "internal_only",
      includeAdminOnly: req.currentUser!.role === "admin",
      imageBuffers,
      promptVersion: parsed.data.promptVersion,
    });

    await db.insert(searchQueries).values({
      userId: req.currentUser!.id,
      query: parsed.data.query,
      mode: imageBuffers.length ? "image_chat" : "ai_chat",
      sourceMode: result.answer.sourceMode,
      resultCount: result.usedChunkIds.length,
      promptVersion: result.promptVersion,
      model: result.model,
      usedChunkIds: result.usedChunkIds,
      usedWebSearch: result.usedWebSearch,
      attachmentIds: attachmentIds.length ? attachmentIds : null,
    });
    await audit(req, "ai_ask", "search", undefined, {
      sourceMode: result.answer.sourceMode,
      usedWebSearch: result.usedWebSearch,
      attachmentCount: attachmentIds.length,
    });

    res.json({ ...result, attachmentIds });
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message) });
  }
});

// Autorizované zobrazení přiložené fotografie (jen vlastník nebo admin).
searchRouter.get("/attachments/:id", async (req, res) => {
  const rows = await db
    .select()
    .from(chatAttachments)
    .where(eq(chatAttachments.id, req.params.id))
    .limit(1);
  const att = rows[0];
  if (!att) return res.status(404).json({ error: "Příloha nenalezena." });
  if (
    req.currentUser!.role !== "admin" &&
    att.uploadedByUserId !== req.currentUser!.id
  ) {
    return res.status(403).json({ error: "Nedostatečná oprávnění." });
  }
  try {
    const buffer = await getObjectBuffer(att.objectPath);
    res.setHeader("Content-Type", att.mimeType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(buffer);
  } catch {
    res.status(503).json({ error: "Úložiště není dostupné." });
  }
});
