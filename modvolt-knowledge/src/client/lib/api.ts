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
  originalFileName: string;
  sizeBytes: number;
  createdAt: string;
}

export interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
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

  // Documents
  documents: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return req<{ documents: DocumentRow[] }>(`/documents${qs ? `?${qs}` : ""}`);
  },
  uploadDocument: (form: FormData) =>
    req<{ document: DocumentRow }>("/documents", { method: "POST", body: form }),
  reindexDocument: (id: string) =>
    req<{ ok: boolean }>(`/documents/${id}/reindex`, { method: "POST" }),
  deleteDocument: (id: string) =>
    req<{ ok: boolean }>(`/documents/${id}`, { method: "DELETE" }),
  downloadDocument: (id: string) =>
    req<{ url: string }>(`/documents/${id}/download`),

  // Search & AI
  search: (query: string, sourceMode: SourceMode) =>
    req<{ hits: SearchHit[] }>("/search", {
      method: "POST",
      body: JSON.stringify({ query, sourceMode }),
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
    req<{ settings: Record<string, string>; promptVersions: { version: string; description: string }[] }>(
      "/admin/settings",
    ),
  saveSettings: (settings: Record<string, string>) =>
    req<{ ok: boolean }>("/admin/settings", { method: "PUT", body: JSON.stringify(settings) }),
  audit: () => req<{ logs: any[] }>("/admin/audit"),
  stats: () => req<any>("/admin/stats"),
};
