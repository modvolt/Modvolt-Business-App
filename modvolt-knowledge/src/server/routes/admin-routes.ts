import { createRouter } from "../lib/async-router.js";
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
import {
  listAllPromptVersions,
  isKnownPromptVersion,
  createCustomPrompt,
  updateCustomPrompt,
  deleteCustomPrompt,
} from "../ai/prompts/prompt-store.js";
import { invalidateSettingsCache } from "../lib/settings.js";
import { audit } from "../lib/audit.js";

export const adminRouter = createRouter();

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
  res.json({ settings, promptVersions: await listAllPromptVersions() });
});

const settingsSchema = z.record(z.string(), z.string());

adminRouter.put("/settings", async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Neplatná nastavení." });
  // Aktivní verze promptu musí existovat (vestavěná v kódu nebo vlastní v DB).
  if (parsed.data.ai_prompt_version !== undefined) {
    const requested = parsed.data.ai_prompt_version;
    if (!(await isKnownPromptVersion(requested))) {
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

// --- Vlastní verze promptů ---
// Verze: malá písmena, číslice, pomlčky/podtržítka, tečky (např. "vlastni-1").
const promptVersionPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const createPromptSchema = z.object({
  version: z.string().regex(promptVersionPattern, {
    message:
      "Verze smí obsahovat jen malá písmena, číslice, tečku, pomlčku a podtržítko (max. 64 znaků).",
  }),
  description: z.string().max(200).default(""),
  body: z.string().min(1, "Tělo promptu nesmí být prázdné.").max(20000),
});

adminRouter.post("/prompts", async (req, res) => {
  const parsed = createPromptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? "Neplatná data promptu." });
  }
  const row = await createCustomPrompt(parsed.data);
  await audit(req, "create", "prompt_version", row.version);
  res.status(201).json({ ok: true });
});

const updatePromptSchema = z.object({
  description: z.string().max(200).default(""),
  body: z.string().min(1, "Tělo promptu nesmí být prázdné.").max(20000),
});

adminRouter.put("/prompts/:version", async (req, res) => {
  const parsed = updatePromptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? "Neplatná data promptu." });
  }
  const row = await updateCustomPrompt(req.params.version, parsed.data);
  await audit(req, "update", "prompt_version", row.version);
  res.json({ ok: true });
});

adminRouter.delete("/prompts/:version", async (req, res) => {
  const version = req.params.version;
  // Pokud mažeme aktivně používanou verzi, vrátíme nastavení na výchozí v kódu.
  const [activeRow] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "ai_prompt_version"))
    .limit(1);
  await deleteCustomPrompt(version);
  if (activeRow?.value === version) {
    await db
      .update(appSettings)
      .set({ value: "v1", updatedAt: new Date() })
      .where(eq(appSettings.key, "ai_prompt_version"));
    invalidateSettingsCache();
  }
  await audit(req, "delete", "prompt_version", version);
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

// --- Report tvrdého zámku ČSN ---
// Které reálné dotazy byly vynuceně přepnuty na csn_only a co to spustilo.
// Slouží adminovi k ladění seznamu klíčových slov (false positives/negatives).
adminRouter.get("/csn-lock-queries", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await db
    .select({
      id: searchQueries.id,
      query: searchQueries.query,
      mode: searchQueries.mode,
      sourceMode: searchQueries.sourceMode,
      csnLockTrigger: searchQueries.csnLockTrigger,
      createdAt: searchQueries.createdAt,
      userName: users.name,
    })
    .from(searchQueries)
    .leftJoin(users, eq(users.id, searchQueries.userId))
    .where(eq(searchQueries.csnLockTriggered, true))
    .orderBy(desc(searchQueries.createdAt))
    .limit(limit);

  const [total] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(searchQueries)
    .where(eq(searchQueries.csnLockTriggered, true));

  const [total30d] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(searchQueries)
    .where(
      sql`${searchQueries.csnLockTriggered} = true and ${searchQueries.createdAt} >= now() - interval '30 days'`,
    );

  // Nejčastější spouštěče (klíčová slova / vzory), které zámek aktivovaly.
  const topTriggers = await db
    .select({
      trigger: searchQueries.csnLockTrigger,
      c: sql<number>`count(*)::int`,
    })
    .from(searchQueries)
    .where(
      sql`${searchQueries.csnLockTriggered} = true and ${searchQueries.csnLockTrigger} is not null`,
    )
    .groupBy(searchQueries.csnLockTrigger)
    .orderBy(desc(sql`count(*)`))
    .limit(20);

  res.json({ queries: rows, total: total.c, total30d: total30d.c, topTriggers });
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

// Interní systémový health check (vyžaduje admin). Vrací detaily o stavu
// infrastruktury (DB, S3, OpenAI, web search). Veřejný /health vrací jen
// status/version/time bez odhalení vnitřního stavu.
adminRouter.get("/system-health", async (_req, res) => {
  const { collectSystemHealth } = await import("./health-routes.js");
  const info = await collectSystemHealth();
  res.status(info.status === "ok" ? 200 : 503).json(info);
});
