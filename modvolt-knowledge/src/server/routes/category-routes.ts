import { Router } from "express";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentCategories } from "../db/schema.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { slugify } from "../db/seed-defaults.js";
import { audit } from "../lib/audit.js";

export const categoryRouter = Router();

categoryRouter.use(requireAuth);

categoryRouter.get("/", async (_req, res) => {
  const rows = await db
    .select()
    .from(documentCategories)
    .orderBy(asc(documentCategories.sortOrder), asc(documentCategories.name));
  res.json({ categories: rows });
});

const categorySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parentId: z.string().uuid().optional().or(z.literal("")),
  sortOrder: z.number().int().optional(),
});

categoryRouter.post("/", requireRole("admin"), async (req, res) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Neplatná data." });
  const [cat] = await db
    .insert(documentCategories)
    .values({
      name: parsed.data.name,
      slug: slugify(parsed.data.name),
      description: parsed.data.description ?? null,
      parentId: parsed.data.parentId || null,
      sortOrder: parsed.data.sortOrder ?? 0,
    })
    .returning();
  await audit(req, "create", "category", cat.id);
  res.status(201).json({ category: cat });
});

categoryRouter.patch("/:id", requireRole("admin"), async (req, res) => {
  const parsed = categorySchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Neplatná data." });
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name) {
    updates.name = parsed.data.name;
    updates.slug = slugify(parsed.data.name);
  }
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (parsed.data.sortOrder !== undefined) updates.sortOrder = parsed.data.sortOrder;
  const [cat] = await db
    .update(documentCategories)
    .set(updates)
    .where(eq(documentCategories.id, req.params.id))
    .returning();
  if (!cat) return res.status(404).json({ error: "Kategorie nenalezena." });
  res.json({ category: cat });
});

categoryRouter.delete("/:id", requireRole("admin"), async (req, res) => {
  await db.delete(documentCategories).where(eq(documentCategories.id, req.params.id));
  await audit(req, "delete", "category", req.params.id);
  res.json({ ok: true });
});
