import type { SessionUser, AiAnswer, SourceMode } from "../../shared/types.js";

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
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data?.error || `Chyba ${res.status}`);
  }
  return data as T;
}

export interface Capabilities {
  aiChat: boolean;
  vision: boolean;
  webSearch: boolean;
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
};
