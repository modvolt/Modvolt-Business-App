import React, { useEffect, useState } from "react";
import { api, type DocumentRow, type CategoryRow } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

const DOC_TYPES = [
  "standard",
  "norm",
  "manual",
  "internal_procedure",
  "datasheet",
  "legal",
  "bozp",
  "template",
  "manufacturer_manual",
  "troubleshooting",
  "other",
];

export function DocumentsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const canWrite = user?.role !== "read_only";

  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

  const load = async () => {
    try {
      const [d, c] = await Promise.all([
        api.documents(q ? { q } : {}),
        api.categories(),
      ]);
      setDocs(d.documents);
      setCategories(c.categories);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = async (id: string) => {
    try {
      const { url } = await api.downloadDocument(id);
      window.open(url, "_blank");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Opravdu smazat dokument?")) return;
    await api.deleteDocument(id);
    load();
  };

  const reindex = async (id: string) => {
    await api.reindexDocument(id);
    load();
  };

  return (
    <div>
      <div className="flex-between">
        <h1 className="page-title">Dokumenty</h1>
        {canWrite && (
          <button onClick={() => setShowUpload((s) => !s)}>
            {showUpload ? "Zavřít" : "Nahrát dokument"}
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {showUpload && canWrite && (
        <UploadForm
          categories={categories}
          onUploaded={() => {
            setShowUpload(false);
            load();
          }}
        />
      )}

      <div className="card">
        <div className="row">
          <input
            placeholder="Filtrovat podle názvu…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
          <button className="secondary" style={{ flex: "0 0 auto" }} onClick={load}>
            Filtrovat
          </button>
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Název</th>
              <th>Typ</th>
              <th>Stav</th>
              <th>Viditelnost</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>{d.title}</td>
                <td className="tag">{d.documentType}</td>
                <td>
                  <span className={`badge ${d.status}`}>{d.status}</span>
                </td>
                <td className="tag">
                  {d.visibility === "admin_only" ? "Jen admin" : "Všichni"}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button className="ghost" onClick={() => download(d.id)}>
                    Stáhnout
                  </button>
                  {canWrite && (
                    <button className="ghost" onClick={() => reindex(d.id)}>
                      Reindex
                    </button>
                  )}
                  {isAdmin && (
                    <button className="ghost" onClick={() => remove(d.id)}>
                      Smazat
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {docs.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Žádné dokumenty.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UploadForm({
  categories,
  onUploaded,
}: {
  categories: CategoryRow[];
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [documentType, setDocumentType] = useState("other");
  const [visibility, setVisibility] = useState("all_users");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      if (title) form.append("title", title);
      if (categoryId) form.append("categoryId", categoryId);
      form.append("documentType", documentType);
      form.append("visibility", visibility);
      await api.uploadDocument(form);
      onUploaded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h3 style={{ marginTop: 0 }}>Nahrát nový dokument</h3>
      <div className="field">
        <label>Soubor (PDF, DOCX, XLSX, TXT, MD, CSV)</label>
        <input
          type="file"
          accept=".pdf,.docx,.xlsx,.txt,.md,.markdown,.csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
      </div>
      <div className="field">
        <label>Název (volitelné)</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="row">
        <div className="field">
          <label>Kategorie</label>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Typ</label>
          <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Viditelnost</label>
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="all_users">Všichni</option>
            <option value="admin_only">Jen admin</option>
          </select>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={busy}>
        {busy ? "Nahrávám…" : "Nahrát"}
      </button>
    </form>
  );
}
