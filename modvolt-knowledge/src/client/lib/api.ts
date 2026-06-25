import type {
  SessionUser,
  AiAnswer,
  SourceMode,
  AiDiagnostics,
} from "../../shared/types.js";

async function req<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers:
      options.body instanceof FormData
        ? undefined
        : { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Tělo není JSON (např. HTML chyba z proxy) – necháme prázdné, ať se použije
    // obecný fallback s HTTP statusem níže.
    data = {};
  }
  if (!res.ok) {
    // Vždy upřednostni konkrétní hlášku z API; obecný fallback se statusem
    // ponech jen pro úplně chybějící/neparsovatelné tělo odpovědi.
    throw new Error(data?.error || `Chyba ${res.status}`);
  }
  return data as T;
}

// Výchozí velikost části (server může vrátit jinou při zahájení relace).
const BULK_CHUNK_SIZE = 5 * 1024 * 1024;
const CHUNK_RETRIES = 4;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Trvalá chyba (4xx mimo 429) – nemá smysl opakovat.
class PermanentUploadError extends Error {}

async function postChunkWithRetry(
  uploadId: string,
  fileIndex: number,
  chunkIndex: number,
  blob: Blob,
): Promise<void> {
  let lastErr: Error = new Error("Nahrávání části selhalo.");
  for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
    try {
      const fd = new FormData();
      fd.append("fileIndex", String(fileIndex));
      fd.append("chunkIndex", String(chunkIndex));
      fd.append("chunk", blob);
      const res = await fetch(
        `/api/documents/bulk/session/${uploadId}/chunk`,
        { method: "POST", credentials: "include", body: fd },
      );
      if (res.ok) return;
      // 4xx (kromě 429) je trvalá chyba – přestaň zkoušet.
      if (res.status < 500 && res.status !== 429) {
        const e = await res.json().catch(() => ({}));
        throw new PermanentUploadError(
          e?.error || `Nahrávání části selhalo (${res.status}).`,
        );
      }
      lastErr = new Error(`Server odpověděl ${res.status}.`);
    } catch (err) {
      if (err instanceof PermanentUploadError) throw err;
      // Síťová chyba / výpadek připojení – zkusíme znovu.
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < CHUNK_RETRIES) {
      await delay(Math.min(1000 * 2 ** attempt, 8000));
    }
  }
  throw lastErr;
}

// Obnovení přerušeného nahrávání: ID relace si pamatujeme v localStorage spolu
// s "podpisem" výběru souborů (názvy+velikosti). Když uživatel po výpadku zkusí
// nahrát tytéž soubory znovu, navážeme na rozdělanou relaci a přeskočíme části,
// které server už má (nenahráváme znovu celých 208 MB).
const RESUME_KEY = "modvolt.bulkUpload";

function uploadSignature(files: File[], autoClassify: boolean): string {
  // Identita zahrnuje i čas změny – jiný/přegenerovaný soubor se stejným názvem
  // i velikostí má jiný timestamp, takže se na starou relaci omylem nenaváže.
  return JSON.stringify({
    a: autoClassify,
    f: files.map((f) => `${f.name}:${f.size}:${f.lastModified}`),
  });
}

function loadResume(
  signature: string,
): { uploadId: string; chunkSize: number } | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && v.signature === signature && typeof v.uploadId === "string") {
      return {
        uploadId: v.uploadId,
        chunkSize: Number(v.chunkSize) || BULK_CHUNK_SIZE,
      };
    }
  } catch {
    /* nečitelné / nedostupné úložiště – prostě začneme znovu */
  }
  return null;
}

function saveResume(
  uploadId: string,
  signature: string,
  chunkSize: number,
): void {
  try {
    localStorage.setItem(
      RESUME_KEY,
      JSON.stringify({ uploadId, signature, chunkSize }),
    );
  } catch {
    /* např. soukromý režim – obnovení pak nebude dostupné, nevadí */
  }
}

function clearResume(): void {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    /* ignore */
  }
}

async function uploadBulkChunked(
  files: File[],
  autoClassify: boolean,
  onProgress?: (pct: number) => void,
): Promise<BulkImportStarted> {
  if (!files.length) throw new Error("Nebyly vybrány žádné soubory.");
  const signature = uploadSignature(files, autoClassify);

  let uploadId = "";
  let chunkSize = BULK_CHUNK_SIZE;
  let receivedPerFile: number[][] = files.map(() => []);

  // (1a) Pokus o navázání na přerušenou relaci pro tentýž výběr souborů.
  const resume = loadResume(signature);
  if (resume) {
    try {
      const statusRes = await fetch(
        `/api/documents/bulk/session/${resume.uploadId}`,
        { credentials: "include" },
      );
      if (statusRes.ok) {
        const s = (await statusRes.json()) as {
          chunkSize?: number;
          files: {
            name: string;
            size: number;
            lastModified?: number;
            received: number[];
          }[];
        };
        const matches =
          s.files.length === files.length &&
          s.files.every(
            (f, i) =>
              f.name === files[i].name &&
              f.size === files[i].size &&
              (f.lastModified ?? 0) === files[i].lastModified,
          );
        if (matches) {
          uploadId = resume.uploadId;
          chunkSize = s.chunkSize || resume.chunkSize;
          receivedPerFile = s.files.map((f) => f.received ?? []);
        }
      }
    } catch {
      /* obnovení nevyšlo – založíme novou relaci níže */
    }
  }

  // (1b) Není co obnovit → zahájení nové relace.
  if (!uploadId) {
    const initRes = await fetch("/api/documents/bulk/session", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: files.map((f) => ({
          name: f.name,
          size: f.size,
          lastModified: f.lastModified,
        })),
        autoClassify,
      }),
    });
    if (!initRes.ok) {
      const e = await initRes.json().catch(() => ({}));
      throw new Error(
        e?.error || `Nepodařilo se zahájit nahrávání (${initRes.status}).`,
      );
    }
    const init = (await initRes.json()) as {
      uploadId: string;
      chunkSize?: number;
    };
    uploadId = init.uploadId;
    chunkSize = init.chunkSize || BULK_CHUNK_SIZE;
    receivedPerFile = files.map(() => []);
    saveResume(uploadId, signature, chunkSize);
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0) || 1;
  let uploaded = 0;

  // (2) Nahrání částí (přeskoč už přijaté; každou s opakováním při výpadku).
  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const have = new Set(receivedPerFile[fi]);
    const nChunks = Math.max(1, Math.ceil(file.size / chunkSize));
    for (let ci = 0; ci < nChunks; ci++) {
      const start = ci * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      if (!have.has(ci)) {
        try {
          await postChunkWithRetry(uploadId, fi, ci, file.slice(start, end));
        } catch (err) {
          // Trvalá chyba (relace vypršela / neplatný požadavek) → zahodit, ať
          // další pokus začne načisto. Dočasný výpadek relaci ponechá k obnovení.
          if (err instanceof PermanentUploadError) clearResume();
          throw err;
        }
      }
      uploaded += end - start;
      // 100 % necháme až na úspěšný commit.
      onProgress?.(Math.min(99, Math.round((uploaded / totalBytes) * 100)));
    }
  }

  // (3) Dokončení → server spojí části, založí job a vrátí jeho ID.
  const commitRes = await fetch(
    `/api/documents/bulk/session/${uploadId}/commit`,
    { method: "POST", credentials: "include" },
  );
  if (!commitRes.ok) {
    const e = await commitRes.json().catch(() => ({}));
    // 4xx z commitu je trvalé (např. neúplný soubor) → relaci zahodit.
    if (commitRes.status >= 400 && commitRes.status < 500) clearResume();
    throw new Error(
      e?.error || `Dokončení nahrávání selhalo (${commitRes.status}).`,
    );
  }
  const data = (await commitRes.json()) as {
    jobId: string;
    autoClassify?: boolean;
  };
  clearResume();
  onProgress?.(100);
  return { jobId: data.jobId, autoClassify: data.autoClassify ?? false };
}

export interface Capabilities {
  aiChat: boolean;
  vision: boolean;
  webSearch: boolean;
  ocr: boolean;
}

export interface DocumentRow {
  id: string;
  title: string;
  description: string | null;
  categoryId: string | null;
  documentType: string;
  status: string;
  visibility: string;
  sourceName: string | null;
  sourceUrl: string | null;
  version: string | null;
  validFrom: string | null;
  validTo: string | null;
  originalFileName: string;
  sizeBytes: number;
  createdAt: string;
  ocrApplied?: boolean;
  tagIds?: string[];
}

export interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
}

export interface TagRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  documentCount: number;
}

export interface IndexingJobRow {
  id: string;
  documentId: string;
  documentTitle: string | null;
  status: string;
  jobType: string;
  attempts: number;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface BatchAnalyzeItem {
  fileName: string;
  sizeBytes: number;
  documentType: string;
  categoryId: string | null;
  tagIds: string[];
  title: string;
  description: string;
  aiClassified: boolean;
  duplicate: { id: string; title: string } | null;
  error: string | null;
}

export interface BatchCommitResult {
  fileName: string;
  status: "created" | "skipped" | "duplicate" | "error";
  documentId?: string;
  existingDocumentId?: string;
  error?: string;
}

export interface ReclassifyFields {
  title: string;
  description: string;
  documentType: string;
  categoryId: string | null;
  tagIds: string[];
}

export interface ReclassifyAnalyzeItem {
  documentId: string;
  fileName: string;
  current: ReclassifyFields | null;
  suggestion: ReclassifyFields | null;
  aiClassified: boolean;
  error: string | null;
}

export interface ReclassifyCommitItem {
  documentId: string;
  title?: string;
  description?: string;
  documentType?: string;
  categoryId?: string;
  tagIds?: string[];
  skip?: boolean;
}

export interface ReclassifyCommitResult {
  documentId: string;
  status: "updated" | "skipped" | "error";
  error?: string;
}

export interface ZipExpandResult {
  sessionToken: string;
  files: { entryId: string; fileName: string; sizeBytes: number }[];
  skipped: { fileName: string; reason: string }[];
}

export interface BulkImportStarted {
  jobId: string;
  autoClassify: boolean;
}

export interface BulkJobStatus {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  autoClassify: boolean;
  totalFiles: number;
  processedFiles: number;
  accepted: number;
  duplicates: number;
  skippedCount: number;
  errorCount: number;
  limitReached: boolean;
  skipped: { fileName: string; reason: string }[];
  errors: { fileName: string; error: string }[];
  lastError: string | null;
}

export interface QueueStatus {
  jobs: { queued: number; processing: number };
  docs: Record<string, number>;
}

export interface SearchFilters {
  sourceMode?: SourceMode;
  categoryId?: string;
  status?: string;
  documentTypes?: string[];
  tagIds?: string[];
  version?: string;
  validOn?: string;
}

export interface PromptVersionInfo {
  version: string;
  description: string;
  body: string;
  preview: string;
  builtIn: boolean;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  documentType: string;
  pageNumber: number | null;
  sectionTitle: string | null;
  content: string;
  score: number;
  matchType: string;
}

export const api = {
  capabilities: () => req<Capabilities>("/capabilities"),

  // Auth
  login: (email: string, password: string) =>
    req<{ user: SessionUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  me: () => req<{ user: SessionUser }>("/auth/me"),

  // Categories
  categories: () => req<{ categories: CategoryRow[] }>("/categories"),
  createCategory: (data: { name: string; description?: string; sortOrder?: number }) =>
    req<{ category: CategoryRow }>("/categories", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateCategory: (id: string, data: Partial<{ name: string; description: string; sortOrder: number }>) =>
    req<{ category: CategoryRow }>(`/categories/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteCategory: (id: string) =>
    req<{ ok: boolean }>(`/categories/${id}`, { method: "DELETE" }),

  // Tags
  tags: () => req<{ tags: TagRow[] }>("/tags"),
  createTag: (name: string) =>
    req<{ tag: TagRow }>("/tags", { method: "POST", body: JSON.stringify({ name }) }),
  updateTag: (id: string, name: string) =>
    req<{ tag: TagRow }>(`/tags/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteTag: (id: string) =>
    req<{ ok: boolean }>(`/tags/${id}`, { method: "DELETE" }),

  // Documents
  documents: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return req<{ documents: DocumentRow[] }>(`/documents${qs ? `?${qs}` : ""}`);
  },
  document: (id: string) =>
    req<{ document: DocumentRow; tagIds: string[] }>(`/documents/${id}`),
  uploadDocument: (form: FormData) =>
    req<{ document: DocumentRow }>("/documents", { method: "POST", body: form }),
  updateDocument: (id: string, data: Record<string, unknown>) =>
    req<{ document: DocumentRow; tagIds: string[] }>(`/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  reindexDocument: (id: string) =>
    req<{ ok: boolean }>(`/documents/${id}/reindex`, { method: "POST" }),
  ocrDocument: (id: string) =>
    req<{ ok: boolean }>(`/documents/${id}/ocr`, { method: "POST" }),
  deleteDocument: (id: string) =>
    req<{ ok: boolean }>(`/documents/${id}`, { method: "DELETE" }),
  downloadDocument: (id: string) =>
    req<{ url: string }>(`/documents/${id}/download`),
  batchAnalyze: (form: FormData) =>
    req<{ aiEnabled: boolean; results: BatchAnalyzeItem[] }>(
      "/documents/batch/analyze",
      { method: "POST", body: form },
    ),
  batchCommit: (form: FormData) =>
    req<{ results: BatchCommitResult[] }>("/documents/batch/commit", {
      method: "POST",
      body: form,
    }),
  reclassifyAnalyze: (documentIds: string[]) =>
    req<{ aiEnabled: boolean; results: ReclassifyAnalyzeItem[] }>(
      "/documents/reclassify/analyze",
      { method: "POST", body: JSON.stringify({ documentIds }) },
    ),
  reclassifyCommit: (items: ReclassifyCommitItem[]) =>
    req<{ results: ReclassifyCommitResult[] }>("/documents/reclassify/commit", {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  batchExpandZip: (form: FormData) =>
    req<ZipExpandResult>("/documents/batch/zip", {
      method: "POST",
      body: form,
    }),
  discardImportSession: (sessionToken: string) =>
    req<{ ok: boolean }>("/documents/batch/session/discard", {
      method: "POST",
      body: JSON.stringify({ sessionToken }),
    }),
  // Odolné nahrávání po částech (chunked / resumable). Soubor se nahraje po
  // malých částech (~5 MB), každá jako samostatný krátký požadavek s opakováním
  // při výpadku → nestálý internet shodí jen jednu část, ne celý soubor, a
  // nevzniká obří požadavek padající na timeout proxy (chyba 502). Server po
  // dokončení vrátí jen ID jobu (202); zpracování běží na pozadí (bulkJob()).
  bulkImport: (
    files: File[],
    autoClassify: boolean,
    onProgress?: (pct: number) => void,
  ) => uploadBulkChunked(files, autoClassify, onProgress),
  bulkJob: (jobId: string) => req<BulkJobStatus>(`/documents/bulk/${jobId}`),
  queueStatus: () => req<QueueStatus>("/documents/queue-status"),

  // Search & AI
  search: (query: string, filters: SearchFilters = {}) =>
    req<{ hits: SearchHit[] }>("/search", {
      method: "POST",
      body: JSON.stringify({ query, ...filters }),
    }),
  ask: (form: FormData) =>
    req<{
      answer: AiAnswer;
      usedChunkIds: string[];
      usedWebSearch: boolean;
      promptVersion: string;
      model: string;
    }>("/ask", { method: "POST", body: form }),

  // Admin
  adminUsers: () => req<{ users: any[] }>("/admin/users"),
  createUser: (data: any) =>
    req<{ user: any }>("/admin/users", { method: "POST", body: JSON.stringify(data) }),
  updateUser: (id: string, data: any) =>
    req<{ user: any }>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteUser: (id: string) =>
    req<{ ok: boolean }>(`/admin/users/${id}`, { method: "DELETE" }),
  settings: () =>
    req<{
      settings: Record<string, string>;
      promptVersions: PromptVersionInfo[];
    }>("/admin/settings"),
  saveSettings: (settings: Record<string, string>) =>
    req<{ ok: boolean }>("/admin/settings", { method: "PUT", body: JSON.stringify(settings) }),
  createPrompt: (data: { version: string; description: string; body: string }) =>
    req<{ ok: boolean }>("/admin/prompts", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updatePrompt: (version: string, data: { description: string; body: string }) =>
    req<{ ok: boolean }>(`/admin/prompts/${encodeURIComponent(version)}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deletePrompt: (version: string) =>
    req<{ ok: boolean }>(`/admin/prompts/${encodeURIComponent(version)}`, {
      method: "DELETE",
    }),
  audit: () => req<{ logs: any[] }>("/admin/audit"),
  csnLockQueries: () =>
    req<{
      queries: {
        id: string;
        query: string;
        mode: string;
        sourceMode: string | null;
        csnLockTrigger: string | null;
        createdAt: string;
        userName: string | null;
      }[];
      total: number;
      total30d: number;
      topTriggers: { trigger: string | null; c: number }[];
    }>("/admin/csn-lock-queries"),
  stats: () => req<any>("/admin/stats"),
  indexingJobs: () => req<{ jobs: IndexingJobRow[] }>("/admin/indexing-jobs"),
  retryIndexing: (documentId: string) =>
    req<{ ok: boolean }>("/admin/indexing-jobs/retry", {
      method: "POST",
      body: JSON.stringify({ documentId }),
    }),
  aiDiagnostics: () => req<AiDiagnostics>("/admin/ai-diagnostics"),
};
