import React, { useEffect, useState } from "react";
import {
  api,
  type DocumentRow,
  type CategoryRow,
  type TagRow,
  type BatchAnalyzeItem,
  type BatchCommitResult,
  type ReclassifyAnalyzeItem,
  type ReclassifyCommitResult,
  type ReclassifyFields,
} from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { DOCUMENT_TYPES } from "../../shared/types.js";

const DOC_TYPES = DOCUMENT_TYPES;

export function DocumentsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const canWrite = user?.role !== "read_only";

  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [reclassifyIds, setReclassifyIds] = useState<string[] | null>(null);

  const load = async () => {
    try {
      const [d, c, t] = await Promise.all([
        api.documents(q ? { q } : {}),
        api.categories(),
        api.tags(),
      ]);
      setDocs(d.documents);
      setCategories(c.categories);
      setTags(t.tags);
      // Vyčisti výběr od dokumentů, které už v seznamu nejsou.
      const present = new Set(d.documents.map((x) => x.id));
      setSelected((prev) => prev.filter((id) => present.has(id)));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const allSelected = docs.length > 0 && selected.length === docs.length;
  const toggleSelectAll = () =>
    setSelected(allSelected ? [] : docs.map((d) => d.id));

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
          <div className="row" style={{ flex: "0 0 auto" }}>
            <button
              className="secondary"
              style={{ flex: "0 0 auto" }}
              disabled={selected.length === 0}
              onClick={() => setReclassifyIds(selected)}
              title={
                selected.length === 0
                  ? "Vyberte dokumenty zaškrtnutím v seznamu"
                  : "Navrhnout přeřazení vybraných dokumentů pomocí AI"
              }
            >
              AI přeřadit ({selected.length})
            </button>
            <button
              className="secondary"
              style={{ flex: "0 0 auto" }}
              onClick={() => {
                setShowBatch((s) => !s);
                setShowUpload(false);
              }}
            >
              {showBatch ? "Zavřít" : "Hromadný import"}
            </button>
            <button
              style={{ flex: "0 0 auto" }}
              onClick={() => {
                setShowUpload((s) => !s);
                setShowBatch(false);
              }}
            >
              {showUpload ? "Zavřít" : "Nahrát dokument"}
            </button>
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {showUpload && canWrite && (
        <UploadForm
          categories={categories}
          tags={tags}
          onUploaded={() => {
            setShowUpload(false);
            load();
          }}
        />
      )}

      {showBatch && canWrite && (
        <BatchImport
          categories={categories}
          tags={tags}
          onDone={() => load()}
          onClose={() => setShowBatch(false)}
        />
      )}

      {reclassifyIds && canWrite && (
        <ReclassifyPanel
          documentIds={reclassifyIds}
          categories={categories}
          tags={tags}
          onDone={() => load()}
          onClose={() => {
            setReclassifyIds(null);
            setSelected([]);
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
              {canWrite && (
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    title="Vybrat vše"
                  />
                </th>
              )}
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
                {canWrite && (
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.includes(d.id)}
                      onChange={() => toggleSelect(d.id)}
                    />
                  </td>
                )}
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
                <td colSpan={canWrite ? 6 : 5} className="muted">
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
  tags,
  onUploaded,
}: {
  categories: CategoryRow[];
  tags: TagRow[];
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [documentType, setDocumentType] = useState("other");
  const [visibility, setVisibility] = useState("all_users");
  const [version, setVersion] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggleTag = (id: string) =>
    setTagIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));

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
      if (version.trim()) form.append("version", version.trim());
      if (sourceName.trim()) form.append("sourceName", sourceName.trim());
      if (sourceUrl.trim()) form.append("sourceUrl", sourceUrl.trim());
      if (validFrom) form.append("validFrom", validFrom);
      if (validTo) form.append("validTo", validTo);
      if (tagIds.length) form.append("tagIds", JSON.stringify(tagIds));
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

      <div className="row">
        <div className="field">
          <label>Verze (volitelné)</label>
          <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="např. 2024" />
        </div>
        <div className="field">
          <label>Platné od (volitelné)</label>
          <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>Platné do (volitelné)</label>
          <input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label>Zdroj / vydavatel (volitelné)</label>
          <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} />
        </div>
        <div className="field">
          <label>Odkaz na zdroj (volitelné)</label>
          <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" />
        </div>
      </div>

      {tags.length > 0 && (
        <div className="field">
          <label>Štítky (volitelné)</label>
          <div className="chip-group">
            {tags.map((t) => (
              <span
                key={t.id}
                className={`chip ${tagIds.includes(t.id) ? "active" : ""}`}
                onClick={() => toggleTag(t.id)}
              >
                {t.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={busy}>
        {busy ? "Nahrávám…" : "Nahrát"}
      </button>
    </form>
  );
}

type RowStatus =
  | "pending"
  | "analyzing"
  | "ready"
  | "committing"
  | "created"
  | "skipped"
  | "duplicate"
  | "error";

interface BatchRow {
  file: File;
  fileName: string;
  status: RowStatus;
  message: string;
  aiClassified: boolean;
  duplicate: { id: string; title: string } | null;
  title: string;
  description: string;
  documentType: string;
  categoryId: string;
  visibility: string;
  tagIds: string[];
  skip: boolean;
}

function newRow(file: File): BatchRow {
  return {
    file,
    fileName: file.name,
    status: "pending",
    message: "",
    aiClassified: false,
    duplicate: null,
    title: file.name.replace(/\.[^.]+$/, ""),
    description: "",
    documentType: "other",
    categoryId: "",
    visibility: "all_users",
    tagIds: [],
    skip: false,
  };
}

function BatchImport({
  categories,
  tags,
  onDone,
  onClose,
}: {
  categories: CategoryRow[];
  tags: TagRow[];
  onDone: () => void;
  onClose: () => void;
}) {
  const { capabilities } = useAuth();
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [phase, setPhase] = useState<"select" | "review">("select");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const updateRow = (idx: number, patch: Partial<BatchRow>) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setRows((prev) => [...prev, ...list.map(newRow)]);
  };

  // Analýza po jednom souboru → viditelný průběh i izolace chyb.
  const analyze = async () => {
    if (!rows.length) return;
    setBusy(true);
    setError("");
    setPhase("review");
    for (let i = 0; i < rows.length; i++) {
      updateRow(i, { status: "analyzing", message: "Analyzuji…" });
      try {
        const form = new FormData();
        form.append("files", rows[i].file);
        const res = await api.batchAnalyze(form);
        const r = res.results[0];
        if (!r) {
          updateRow(i, { status: "error", message: "Bez výsledku analýzy." });
          continue;
        }
        updateRow(i, {
          status: r.error ? "error" : "ready",
          message: r.error ?? "",
          aiClassified: r.aiClassified,
          duplicate: r.duplicate,
          title: r.title,
          description: r.description,
          documentType: r.documentType,
          categoryId: r.categoryId ?? "",
          tagIds: r.tagIds,
          skip: Boolean(r.duplicate),
        });
      } catch (err) {
        updateRow(i, { status: "error", message: (err as Error).message });
      }
    }
    setBusy(false);
  };

  const applyCommitResults = (
    indices: number[],
    results: BatchCommitResult[],
  ) => {
    setRows((prev) =>
      prev.map((r, i) => {
        const pos = indices.indexOf(i);
        if (pos === -1) return r;
        const res = results[pos];
        if (!res) return r;
        if (res.status === "created")
          return { ...r, status: "created", message: "Uloženo." };
        if (res.status === "skipped")
          return { ...r, status: "skipped", message: "Přeskočeno." };
        if (res.status === "duplicate")
          return {
            ...r,
            status: "duplicate",
            message: "Duplicita – přeskočeno.",
          };
        return { ...r, status: "error", message: res.error ?? "Chyba." };
      }),
    );
  };

  const commit = async (indices: number[]) => {
    const committable = indices.filter((i) => {
      const r = rows[i];
      return r && r.status !== "created" && r.status !== "error";
    });
    if (!committable.length) return;
    setBusy(true);
    setError("");
    committable.forEach((i) =>
      updateRow(i, { status: "committing", message: "Ukládám…" }),
    );
    try {
      const form = new FormData();
      const items = committable.map((i) => {
        const r = rows[i];
        return {
          title: r.title,
          description: r.description,
          categoryId: r.categoryId,
          documentType: r.documentType,
          visibility: r.visibility,
          tagIds: r.tagIds,
          skip: r.skip,
        };
      });
      committable.forEach((i) => form.append("files", rows[i].file));
      form.append("items", JSON.stringify(items));
      const res = await api.batchCommit(form);
      applyCommitResults(committable, res.results);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      committable.forEach((i) =>
        updateRow(i, { status: "ready", message: "" }),
      );
    } finally {
      setBusy(false);
    }
  };

  const removeRow = (idx: number) =>
    setRows((prev) => prev.filter((_, i) => i !== idx));

  const reset = () => {
    setRows([]);
    setPhase("select");
    setError("");
  };

  const toggleRowTag = (idx: number, tagId: string) =>
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx
          ? {
              ...r,
              tagIds: r.tagIds.includes(tagId)
                ? r.tagIds.filter((t) => t !== tagId)
                : [...r.tagIds, tagId],
            }
          : r,
      ),
    );

  const pendingCount = rows.filter(
    (r) => r.status !== "created" && r.status !== "error",
  ).length;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Hromadný import dokumentů</h3>

      {!capabilities.aiChat && (
        <div className="muted" style={{ marginBottom: 12 }}>
          Automatická AI klasifikace je vypnutá – soubory se nahrají s výchozím
          typem „other" a klasifikaci doplníte ručně před potvrzením.
        </div>
      )}

      {phase === "select" && (
        <>
          <div
            className={`card ${dragOver ? "active" : ""}`}
            style={{
              border: "2px dashed var(--border, #ccc)",
              textAlign: "center",
              padding: 24,
              background: dragOver ? "rgba(0,0,0,0.03)" : undefined,
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <p className="muted" style={{ marginTop: 0 }}>
              Přetáhněte sem soubory (PDF, DOCX, XLSX, TXT, MD, CSV) nebo je
              vyberte:
            </p>
            <input
              type="file"
              multiple
              accept=".pdf,.docx,.xlsx,.txt,.md,.markdown,.csv"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {rows.length > 0 && (
            <>
              <ul style={{ marginTop: 12 }}>
                {rows.map((r, i) => (
                  <li key={i}>
                    {r.fileName}{" "}
                    <button
                      className="ghost"
                      onClick={() => removeRow(i)}
                      type="button"
                    >
                      Odebrat
                    </button>
                  </li>
                ))}
              </ul>
              <div className="row" style={{ marginTop: 8 }}>
                <button onClick={analyze} disabled={busy}>
                  Analyzovat ({rows.length})
                </button>
                <button className="secondary" onClick={reset} disabled={busy}>
                  Vyčistit
                </button>
              </div>
            </>
          )}
        </>
      )}

      {error && <div className="error">{error}</div>}

      {phase === "review" && (
        <>
          <div className="row" style={{ margin: "8px 0" }}>
            <button onClick={() => commit(rows.map((_, i) => i))} disabled={busy}>
              {busy ? "Zpracovávám…" : `Potvrdit vše (${pendingCount})`}
            </button>
            <button className="secondary" onClick={reset} disabled={busy}>
              Začít znovu
            </button>
            <button className="secondary" onClick={onClose} disabled={busy}>
              Zavřít
            </button>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Soubor</th>
                  <th>Název</th>
                  <th>Typ</th>
                  <th>Kategorie</th>
                  <th>Štítky</th>
                  <th>Stav</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>
                      <div>{r.fileName}</div>
                      {r.duplicate && (
                        <span className="badge failed" title={r.duplicate.title}>
                          Duplicita
                        </span>
                      )}
                      {r.aiClassified && (
                        <span className="tag" style={{ marginLeft: 4 }}>
                          AI
                        </span>
                      )}
                    </td>
                    <td>
                      <input
                        value={r.title}
                        onChange={(e) =>
                          updateRow(i, { title: e.target.value })
                        }
                        style={{ minWidth: 160 }}
                      />
                    </td>
                    <td>
                      <select
                        value={r.documentType}
                        onChange={(e) =>
                          updateRow(i, { documentType: e.target.value })
                        }
                      >
                        {DOC_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={r.categoryId}
                        onChange={(e) =>
                          updateRow(i, { categoryId: e.target.value })
                        }
                      >
                        <option value="">—</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div className="chip-group" style={{ maxWidth: 220 }}>
                        {tags.map((t) => (
                          <span
                            key={t.id}
                            className={`chip ${
                              r.tagIds.includes(t.id) ? "active" : ""
                            }`}
                            onClick={() => toggleRowTag(i, t.id)}
                          >
                            {t.name}
                          </span>
                        ))}
                        {tags.length === 0 && (
                          <span className="muted">—</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <BatchStatusBadge status={r.status} />
                      {r.message && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {r.message}
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        className="ghost"
                        disabled={
                          busy ||
                          r.status === "created" ||
                          r.status === "analyzing"
                        }
                        onClick={() => commit([i])}
                      >
                        Potvrdit
                      </button>
                      <label
                        className="muted"
                        style={{ fontSize: 12, marginLeft: 4 }}
                      >
                        <input
                          type="checkbox"
                          checked={r.skip}
                          onChange={(e) =>
                            updateRow(i, { skip: e.target.checked })
                          }
                        />{" "}
                        přeskočit
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function BatchStatusBadge({ status }: { status: RowStatus }) {
  const map: Record<RowStatus, { label: string; cls: string }> = {
    pending: { label: "Čeká", cls: "uploaded" },
    analyzing: { label: "Analyzuji…", cls: "processing" },
    ready: { label: "Připraveno", cls: "uploaded" },
    committing: { label: "Ukládám…", cls: "processing" },
    created: { label: "Uloženo", cls: "indexed" },
    skipped: { label: "Přeskočeno", cls: "archived" },
    duplicate: { label: "Duplicita", cls: "failed" },
    error: { label: "Chyba", cls: "failed" },
  };
  const { label, cls } = map[status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

type ReclassifyStatus =
  | "analyzing"
  | "ready"
  | "committing"
  | "updated"
  | "skipped"
  | "error";

interface ReclassifyRow {
  documentId: string;
  fileName: string;
  status: ReclassifyStatus;
  message: string;
  aiClassified: boolean;
  hasSuggestion: boolean;
  current: ReclassifyFields | null;
  // Hodnoty, které se po potvrzení uloží (výchozí = AI návrh, jinak stávající).
  title: string;
  description: string;
  documentType: string;
  categoryId: string;
  tagIds: string[];
  skip: boolean;
}

function ReclassifyPanel({
  documentIds,
  categories,
  tags,
  onDone,
  onClose,
}: {
  documentIds: string[];
  categories: CategoryRow[];
  tags: TagRow[];
  onDone: () => void;
  onClose: () => void;
}) {
  const { capabilities } = useAuth();
  const [rows, setRows] = useState<ReclassifyRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const catName = (id: string | null) =>
    id ? categories.find((c) => c.id === id)?.name ?? "?" : "—";
  const tagNames = (ids: string[]) =>
    ids.length
      ? ids.map((id) => tags.find((t) => t.id === id)?.name ?? "?").join(", ")
      : "—";

  const updateRow = (idx: number, patch: Partial<ReclassifyRow>) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setBusy(true);
      setError("");
      try {
        const res = await api.reclassifyAnalyze(documentIds);
        if (cancelled) return;
        const next: ReclassifyRow[] = res.results.map((item) => {
          const src: ReclassifyFields | null = item.suggestion ?? item.current;
          return {
            documentId: item.documentId,
            fileName: item.fileName || item.documentId,
            status: item.error ? "error" : "ready",
            message: item.error
              ? item.error
              : item.suggestion
                ? ""
                : "Bez návrhu AI – uloží se stávající hodnoty.",
            aiClassified: item.aiClassified,
            hasSuggestion: Boolean(item.suggestion),
            current: item.current,
            title: src?.title ?? "",
            description: src?.description ?? "",
            documentType: src?.documentType ?? "other",
            categoryId: src?.categoryId ?? "",
            tagIds: src?.tagIds ?? [],
            // Bez návrhu AI je standardně přeskočit (nic by se nezměnilo).
            skip: item.error ? true : !item.suggestion,
          };
        });
        setRows(next);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleRowTag = (idx: number, tagId: string) =>
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx
          ? {
              ...r,
              tagIds: r.tagIds.includes(tagId)
                ? r.tagIds.filter((t) => t !== tagId)
                : [...r.tagIds, tagId],
            }
          : r,
      ),
    );

  const applyResults = (
    indices: number[],
    results: ReclassifyCommitResult[],
  ) => {
    const byId = new Map(results.map((r) => [r.documentId, r]));
    setRows((prev) =>
      prev.map((r, i) => {
        if (!indices.includes(i)) return r;
        const res = byId.get(r.documentId);
        if (!res) return r;
        if (res.status === "updated")
          return { ...r, status: "updated", message: "Uloženo." };
        if (res.status === "skipped")
          return { ...r, status: "skipped", message: "Přeskočeno." };
        return { ...r, status: "error", message: res.error ?? "Chyba." };
      }),
    );
  };

  const commit = async (indices: number[]) => {
    const committable = indices.filter((i) => {
      const r = rows[i];
      return r && r.status !== "updated" && r.status !== "error";
    });
    if (!committable.length) return;
    setBusy(true);
    setError("");
    committable.forEach((i) =>
      updateRow(i, { status: "committing", message: "Ukládám…" }),
    );
    try {
      const items = committable.map((i) => {
        const r = rows[i];
        return {
          documentId: r.documentId,
          title: r.title,
          description: r.description,
          documentType: r.documentType,
          categoryId: r.categoryId,
          tagIds: r.tagIds,
          skip: r.skip,
        };
      });
      const res = await api.reclassifyCommit(items);
      applyResults(committable, res.results);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      committable.forEach((i) => updateRow(i, { status: "ready", message: "" }));
    } finally {
      setBusy(false);
    }
  };

  const pendingCount = rows.filter(
    (r) => r.status !== "updated" && r.status !== "error" && !r.skip,
  ).length;

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>AI přeřazení dokumentů</h3>

      {!capabilities.aiChat && (
        <div className="muted" style={{ marginBottom: 12 }}>
          AI klasifikace je vypnutá – návrhy nelze vygenerovat. Zapněte OpenAI,
          nebo upravte zařazení ručně.
        </div>
      )}

      {busy && rows.length === 0 && (
        <div className="muted">Analyzuji vybrané dokumenty…</div>
      )}

      {error && <div className="error">{error}</div>}

      {rows.length > 0 && (
        <>
          <div className="row" style={{ margin: "8px 0" }}>
            <button
              onClick={() => commit(rows.map((_, i) => i))}
              disabled={busy || pendingCount === 0}
            >
              {busy ? "Zpracovávám…" : `Potvrdit vše (${pendingCount})`}
            </button>
            <button className="secondary" onClick={onClose} disabled={busy}>
              Zavřít
            </button>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Dokument</th>
                  <th>Stávající</th>
                  <th>Návrh (název)</th>
                  <th>Typ</th>
                  <th>Kategorie</th>
                  <th>Štítky</th>
                  <th>Stav</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.documentId}>
                    <td>
                      <div>{r.fileName}</div>
                      {r.aiClassified && (
                        <span className="tag" style={{ marginTop: 4 }}>
                          AI návrh
                        </span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 12, minWidth: 160 }}>
                      {r.current ? (
                        <>
                          <div>{r.current.title}</div>
                          <div>typ: {r.current.documentType}</div>
                          <div>kat.: {catName(r.current.categoryId)}</div>
                          <div>štítky: {tagNames(r.current.tagIds)}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <input
                        value={r.title}
                        onChange={(e) => updateRow(i, { title: e.target.value })}
                        style={{ minWidth: 160 }}
                      />
                    </td>
                    <td>
                      <select
                        value={r.documentType}
                        onChange={(e) =>
                          updateRow(i, { documentType: e.target.value })
                        }
                      >
                        {DOC_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={r.categoryId}
                        onChange={(e) =>
                          updateRow(i, { categoryId: e.target.value })
                        }
                      >
                        <option value="">—</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <div className="chip-group" style={{ maxWidth: 220 }}>
                        {tags.map((t) => (
                          <span
                            key={t.id}
                            className={`chip ${
                              r.tagIds.includes(t.id) ? "active" : ""
                            }`}
                            onClick={() => toggleRowTag(i, t.id)}
                          >
                            {t.name}
                          </span>
                        ))}
                        {tags.length === 0 && <span className="muted">—</span>}
                      </div>
                    </td>
                    <td>
                      <ReclassifyStatusBadge status={r.status} />
                      {r.message && (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {r.message}
                        </div>
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button
                        className="ghost"
                        disabled={
                          busy ||
                          r.status === "updated" ||
                          r.status === "committing"
                        }
                        onClick={() => commit([i])}
                      >
                        Potvrdit
                      </button>
                      <label
                        className="muted"
                        style={{ fontSize: 12, marginLeft: 4 }}
                      >
                        <input
                          type="checkbox"
                          checked={r.skip}
                          onChange={(e) =>
                            updateRow(i, { skip: e.target.checked })
                          }
                        />{" "}
                        přeskočit
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ReclassifyStatusBadge({ status }: { status: ReclassifyStatus }) {
  const map: Record<ReclassifyStatus, { label: string; cls: string }> = {
    analyzing: { label: "Analyzuji…", cls: "processing" },
    ready: { label: "Připraveno", cls: "uploaded" },
    committing: { label: "Ukládám…", cls: "processing" },
    updated: { label: "Uloženo", cls: "indexed" },
    skipped: { label: "Přeskočeno", cls: "archived" },
    error: { label: "Chyba", cls: "failed" },
  };
  const { label, cls } = map[status];
  return <span className={`badge ${cls}`}>{label}</span>;
}
