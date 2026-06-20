import type { UserRole } from "../../shared/types.js";

// Subjekt (přihlášený uživatel) a cíl (dokument) pro rozhodnutí o zápisu.
export interface DocumentAccessSubject {
  id: string;
  role: UserRole | string;
}

export interface DocumentAccessTarget {
  uploadedByUserId: string | null;
  visibility: string;
}

export type DocumentWriteDecision =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Čistá autorizační logika pro zápis do dokumentu (úprava / reindex / nová verze).
 * Admin smí vše; ostatní jen vlastní dokumenty s viditelností all_users.
 * admin_only dokumenty jsou pro ne-adminy vždy zakázané.
 */
export function authorizeDocumentWrite(
  doc: DocumentAccessTarget,
  user: DocumentAccessSubject,
): DocumentWriteDecision {
  if (user.role === "admin") return { ok: true };
  if (doc.visibility === "admin_only") {
    return { ok: false, status: 403, error: "Nedostatečná oprávnění." };
  }
  if (doc.uploadedByUserId !== user.id) {
    return {
      ok: false,
      status: 403,
      error: "Lze upravovat jen vlastní dokumenty.",
    };
  }
  return { ok: true };
}
