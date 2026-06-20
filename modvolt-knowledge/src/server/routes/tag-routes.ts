import { createRouter } from "../lib/async-router.js";
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentTags, documentTagLinks } from "../db/schema.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { slugify } from "../db/seed-defaults.js";
import { audit } from "../lib/audit.js";

export const tagRouter = createRouter();

tagRouter.use(requireAuth);

// Seznam štítků včetně počtu navázaných dokumentů.
tagRouter.get("/", async (_req, res) => {
  const rows = await db
    .select({
      id: documentTags.id,
      name: documentTags.name,
      slug: documentTags.slug,
      createdAt: documentTags.createdAt,
      documentCount: sql<number>`(
        SELECT count(*)::int FROM document_tag_links dtl
        WHERE dtl.tag_id = ${documentTags.id}
      )`,
    })
    .from(documentTags)
    .orderBy(asc(documentTags.name));
  res.json({ tags: rows });
});

const tagSchema = z.object({
  name: z.string().min(1),
});

tagRouter.post("/", requireRole("admin"), async (req, res) => {
  const parsed = tagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Neplatná data." });
  const slug = slugify(parsed.data.name);
  const existing = await db
    .select()
    .from(documentTags)
    .where(eq(documentTags.slug, slug))
    .limit(1);
  if (existing.length) {
    return res.status(409).json({ error: "Štítek s tímto názvem již existuje." });
  }
  const [tag] = await db
    .insert(documentTags)
    .values({ name: parsed.data.name, slug })
    .returning();
  await audit(req, "create", "tag", tag.id);
  res.status(201).json({ tag });
});

tagRouter.patch("/:id", requireRole("admin"), async (req, res) => {
  const parsed = tagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Neplatná data." });
  const [tag] = await db
    .update(documentTags)
    .set({ name: parsed.data.name, slug: slugify(parsed.data.name) })
    .where(eq(documentTags.id, req.params.id))
    .returning();
  if (!tag) return res.status(404).json({ error: "Štítek nenalezen." });
  await audit(req, "update", "tag", tag.id);
  res.json({ tag });
});

tagRouter.delete("/:id", requireRole("admin"), async (req, res) => {
  await db.delete(documentTagLinks).where(eq(documentTagLinks.tagId, req.params.id));
  await db.delete(documentTags).where(eq(documentTags.id, req.params.id));
  await audit(req, "delete", "tag", req.params.id);
  res.json({ ok: true });
});
