import React, { useEffect, useState } from "react";
import {
  api,
  type SearchHit,
  type CategoryRow,
  type TagRow,
  type SearchFilters,
} from "../lib/api.js";
import type { SourceMode } from "../../shared/types.js";

const MODES: { key: SourceMode; label: string }[] = [
  { key: "internal_only", label: "Pouze interní" },
  { key: "csn_only", label: "Pouze ČSN/normy" },
];

const DOC_TYPES: { key: string; label: string }[] = [
  { key: "standard", label: "Standard" },
  { key: "norm", label: "Norma / ČSN" },
  { key: "manual", label: "Manuál" },
  { key: "internal_procedure", label: "Interní postup" },
  { key: "datasheet", label: "Datasheet" },
  { key: "legal", label: "Legislativa" },
  { key: "bozp", label: "BOZP" },
  { key: "template", label: "Šablona" },
  { key: "manufacturer_manual", label: "Manuál výrobce" },
  { key: "troubleshooting", label: "Řešení potíží" },
  { key: "other", label: "Ostatní" },
];

const STATUSES: { key: string; label: string }[] = [
  { key: "", label: "Libovolný stav" },
  { key: "indexed", label: "Zaindexováno" },
  { key: "processing", label: "Zpracovává se" },
  { key: "needs_review", label: "Ke kontrole" },
  { key: "archived", label: "Archivováno" },
];

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [sourceMode, setSourceMode] = useState<SourceMode>("internal_only");
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState("");
  const [documentTypes, setDocumentTypes] = useState<string[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [validOn, setValidOn] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);

  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    api.categories().then((r) => setCategories(r.categories)).catch(() => {});
    api.tags().then((r) => setTags(r.tags)).catch(() => {});
  }, []);

  const toggle = (
    value: string,
    list: string[],
    setList: (v: string[]) => void,
  ) => {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError("");
    try {
      const filters: SearchFilters = {
        sourceMode,
        ...(categoryId ? { categoryId } : {}),
        ...(status ? { status } : {}),
        ...(documentTypes.length ? { documentTypes } : {}),
        ...(tagIds.length ? { tagIds } : {}),
        ...(version.trim() ? { version: version.trim() } : {}),
        ...(validOn ? { validOn } : {}),
      };
      const res = await api.search(query, filters);
      setHits(res.hits);
      setSearched(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">Vyhledávání v dokumentech</h1>
      <form className="card" onSubmit={run}>
        <div className="field">
          <input
            placeholder="Hledat v interních dokumentech…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex-between">
          <div className="chip-group">
            {MODES.map((m) => (
              <span
                key={m.key}
                className={`chip ${sourceMode === m.key ? "active" : ""}`}
                onClick={() => setSourceMode(m.key)}
              >
                {m.label}
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="ghost"
              onClick={() => setShowFilters((s) => !s)}
            >
              {showFilters ? "Skrýt filtry" : "Filtry"}
            </button>
            <button type="submit" disabled={busy}>
              {busy ? "Hledám…" : "Hledat"}
            </button>
          </div>
        </div>

        {showFilters && (
          <div style={{ marginTop: 16, borderTop: "1px solid var(--border, #eee)", paddingTop: 16 }}>
            <div className="row">
              <div className="field">
                <label>Kategorie</label>
                <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">Všechny kategorie</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Stav</label>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  {STATUSES.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Verze</label>
                <input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="např. 2024"
                />
              </div>
              <div className="field">
                <label>Platné k datu</label>
                <input
                  type="date"
                  value={validOn}
                  onChange={(e) => setValidOn(e.target.value)}
                />
              </div>
            </div>

            <div className="field">
              <label>Typ dokumentu</label>
              <div className="chip-group">
                {DOC_TYPES.map((t) => (
                  <span
                    key={t.key}
                    className={`chip ${documentTypes.includes(t.key) ? "active" : ""}`}
                    onClick={() => toggle(t.key, documentTypes, setDocumentTypes)}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>

            {tags.length > 0 && (
              <div className="field">
                <label>Štítky</label>
                <div className="chip-group">
                  {tags.map((t) => (
                    <span
                      key={t.id}
                      className={`chip ${tagIds.includes(t.id) ? "active" : ""}`}
                      onClick={() => toggle(t.id, tagIds, setTagIds)}
                    >
                      {t.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </form>

      {error && <div className="error">{error}</div>}

      {searched && hits.length === 0 && !busy && (
        <div className="notice">Žádné výsledky. Zkus jiný dotaz, režim nebo filtry.</div>
      )}

      {hits.map((h) => (
        <div className="card" key={h.chunkId}>
          <div className="flex-between">
            <strong>{h.title}</strong>
            <span className="tag">
              {h.matchType} · {h.score.toFixed(3)}
            </span>
          </div>
          {h.sectionTitle && <div className="tag">{h.sectionTitle}</div>}
          <p style={{ marginBottom: 0 }}>{h.content.slice(0, 400)}…</p>
        </div>
      ))}
    </div>
  );
}
