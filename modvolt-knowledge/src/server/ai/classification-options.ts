import { asc } from "drizzle-orm";
import { db } from "../db/index.js";
import { documentCategories, documentTags } from "../db/schema.js";
import type {
  ClassificationCategory,
  ClassificationTag,
} from "./classification-service.js";

/**
 * Načte aktuální kategorie a štítky pro AI klasifikaci (id + název, seřazené
 * podle názvu). Sdílené mezi synchronní dávkou (routes) a hromadným importem
 * na pozadí (worker). AI z těchto možností pouze vybírá – nevymýšlí nové.
 */
export async function loadClassificationOptions(): Promise<{
  categories: ClassificationCategory[];
  tags: ClassificationTag[];
}> {
  const [categories, tags] = await Promise.all([
    db
      .select({ id: documentCategories.id, name: documentCategories.name })
      .from(documentCategories)
      .orderBy(asc(documentCategories.name)),
    db
      .select({ id: documentTags.id, name: documentTags.name })
      .from(documentTags)
      .orderBy(asc(documentTags.name)),
  ]);
  return { categories, tags };
}
