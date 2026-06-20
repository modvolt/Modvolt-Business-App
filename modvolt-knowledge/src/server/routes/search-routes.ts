import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { db } from "../db/index.js";
import { searchQueries } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { searchChunks } from "../search/search-service.js";
import { ask, aiChatAvailable } from "../ai/chat-service.js";
import { processImage } from "../documents/image-processing.js";
import { visionAvailable } from "../ai/vision-analysis.js";
import { env } from "../env.js";
import { audit } from "../lib/audit.js";
import type { SourceMode } from "../../shared/types.js";

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

  const imageBuffers: Buffer[] = [];
  for (const f of files) {
    const processed = await processImage(f.buffer);
    imageBuffers.push(processed.buffer);
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
    });
    await audit(req, "ai_ask", "search", undefined, {
      sourceMode: result.answer.sourceMode,
      usedWebSearch: result.usedWebSearch,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String((err as Error).message) });
  }
});
