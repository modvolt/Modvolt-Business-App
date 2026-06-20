import { Router } from "express";
import { z } from "zod";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  users,
  appSettings,
  auditLogs,
  documents,
  documentCategories,
  searchQueries,
  indexingJobs,
} from "../db/schema.js";
import { requireRole } from "../middleware/auth.js";
import { enqueueDocument } from "../indexing/worker.js";
import { hashPassword } from "../auth/password.js";
import { listPromptVersions, getPrompt } from "../ai/prompts/index.js";
import { invalidateSettingsCache } from "../lib/settings.js";
import { audit } from "../lib/audit.js";

export const adminRouter = Router();

adminRouter.use(requireRole("admin"));

// --- Uživatelé ---
adminRouter.get("/users", async (_req, res) => {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
  res.json({ users: rows });
});

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["admin", "user", "read_only"]),
});

adminRouter.post("/users", async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Neplatná data uživatele (heslo min. 8 znaků)." });
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, parsed.data.email.toLowerCase()))
    .limit(1);
  if (existing.length) return res.status(409).json({ error: "E-mail již existuje." });
  const [user] = await db
    .insert(users)
    .values({
      name: parsed.data.name,
      email: parsed.data.email.toLowerCase(),
      passwordHash: await hashPassword(parsed.data.password),
      role: parsed.data.role,
    })
    .returning({ id: users.id, name: users.name, email: users.email, role: users.role });
  await audit(req, "create", "user", user.id);
  res.status(201).json({ user });
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(["admin", "user", "read_only"]).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

adminRouter.patch("/users/:id", async (req, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Neplatná data." });
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name) updates.name = parsed.data.name;
  if (parsed.data.role) updates.role = parsed.data.role;
  if (parsed.data.isActive !== undefined) updates.isActive = parsed.data.isActive;
  if (parsed.data.password) updates.passwordHash = await hashPassword(parsed.data.password);
  const [user] = await db
    .update(users)
    .set(updates)
    .where(eq(users.id, req.params.id))
    .returning({ id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive });
  if (!user) return res.status(404).json({ error: "Uživatel nenalezen." });
  await audit(req, "update", "user", user.id);
  res.json({ user });
});

adminRouter.delete("/users/:id", async (req, res) => {
  if (req.params.id === req.currentUser!.id) {
    return res.status(400).json({ error: "Nelze smazat vlastní účet." });
  }
  await db.delete(users).where(eq(users.id, req.params.id));
  await audit(req, "delete", "user", req.params.id);
  res.json({ ok: true });
});

// --- Nastavení aplikace ---
adminRouter.get("/settings", async (_req, res) => {
  const rows = await db.select().from(appSettings);
  const settings: Record<string, string | null> = {};
  for (const r of rows) settings[r.key] = r.value;
  res.json({ settings, promptVersions: listPromptVersions() });
});

const settingsSchema = z.record(z.string(), z.string());

adminRouter.put("/settings", async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Neplatná nastavení." });
  // Aktivní verze promptu musí existovat v registru promptů v kódu.
  if (parsed.data.ai_prompt_version !== undefined) {
    const requested = parsed.data.ai_prompt_version;
    if (getPrompt(requested).version !== requested) {
      return res
        .status(400)
        .json({ error: `Neznámá verze promptu: ${requested}.` });
    }
  }
  for (const [key, value] of Object.entries(parsed.data)) {
    await db
      .insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }
  // Změny se musí projevit za běhu (bez redeploye) - vyprázdníme cache nastavení.
  invalidateSettingsCache();
  await audit(req, "update", "settings");
  res.json({ ok: true });
});

// --- Audit log ---
adminRouter.get("/audit", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
  res.json({ logs: rows });
});

// --- Statistiky (dashboard) ---
adminRouter.get("/stats", async (_req, res) => {
  const [docCount] = await db.select({ c: sql<number>`count(*)::int` }).from(documents);
  const [userCount] = await db.select({ c: sql<number>`count(*)::int` }).from(users);
  const [queryCount] = await db.select({ c: sql<number>`count(*)::int` }).from(searchQueries);
  const [categoryCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(documentCategories);

  const byStatus = await db
    .select({ status: documents.status, c: sql<number>`count(*)::int` })
    .from(documents)
    .groupBy(documents.status);

  const byType = await db
    .select({ documentType: documents.documentType, c: sql<number>`count(*)::int` })
    .from(documents)
    .groupBy(documents.documentType);

  // Dotazy za posledních 30 dní + rozpad podle režimu.
  const [queries30d] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(searchQueries)
    .where(sql`${searchQueries.createdAt} >= now() - interval '30 days'`);
  const [imageQueries] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(searchQueries)
    .where(eq(searchQueries.mode, "image_chat"));
  const [webQueries] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(searchQueries)
    .where(eq(searchQueries.usedWebSearch, true));
  const byMode = await db
    .select({ mode: searchQueries.mode, c: sql<number>`count(*)::int` })
    .from(searchQueries)
    .groupBy(searchQueries.mode);

  // Indexovací fronta podle stavu.
  const indexingByStatus = await db
    .select({ status: indexingJobs.status, c: sql<number>`count(*)::int` })
    .from(indexingJobs)
    .groupBy(indexingJobs.status);

  // Naposledy nahrané dokumenty.
  const recentDocuments = await db
    .select({
      id: documents.id,
      title: documents.title,
      status: documents.status,
      documentType: documents.documentType,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .orderBy(desc(documents.createdAt))
    .limit(8);

  // Nejčastější kategorie podle počtu dokumentů.
  const topCategories = await db
    .select({
      id: documentCategories.id,
      name: documentCategories.name,
      c: sql<number>`count(${documents.id})::int`,
    })
    .from(documentCategories)
    .leftJoin(documents, eq(documents.categoryId, documentCategories.id))
    .groupBy(documentCategories.id, documentCategories.name)
    .orderBy(desc(sql`count(${documents.id})`))
    .limit(8);

  res.json({
    documents: docCount.c,
    users: userCount.c,
    queries: queryCount.c,
    categories: categoryCount.c,
    queriesLast30d: queries30d.c,
    imageQueries: imageQueries.c,
    webQueries: webQueries.c,
    documentsByStatus: byStatus,
    documentsByType: byType,
    queriesByMode: byMode,
    indexingByStatus,
    recentDocuments,
    topCategories,
  });
});

// --- Indexovací fronta (Import / Indexace) ---
adminRouter.get("/indexing-jobs", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await db
    .select({
      id: indexingJobs.id,
      documentId: indexingJobs.documentId,
      status: indexingJobs.status,
      jobType: indexingJobs.jobType,
      attempts: indexingJobs.attempts,
      lastError: indexingJobs.lastError,
      startedAt: indexingJobs.startedAt,
      finishedAt: indexingJobs.finishedAt,
      createdAt: indexingJobs.createdAt,
      documentTitle: documents.title,
    })
    .from(indexingJobs)
    .leftJoin(documents, eq(documents.id, indexingJobs.documentId))
    .orderBy(desc(indexingJobs.createdAt))
    .limit(limit);
  res.json({ jobs: rows });
});

// Znovu zařadit dokument do fronty (reindex).
adminRouter.post("/indexing-jobs/retry", async (req, res) => {
  const schema = z.object({ documentId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Chybí documentId." });
  await enqueueDocument(parsed.data.documentId, "reindex");
  await audit(req, "reindex", "document", parsed.data.documentId);
  res.json({ ok: true });
});
