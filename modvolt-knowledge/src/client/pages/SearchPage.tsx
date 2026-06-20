import React, { useState } from "react";
import { api, type SearchHit } from "../lib/api.js";
import type { SourceMode } from "../../shared/types.js";

const MODES: { key: SourceMode; label: string }[] = [
  { key: "internal_only", label: "Pouze interní" },
  { key: "csn_only", label: "Pouze ČSN/normy" },
];

export function SearchPage() {
  const [query, setQuery] = useState("");
  const [sourceMode, setSourceMode] = useState<SourceMode>("internal_only");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.search(query, sourceMode);
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
          <button type="submit" disabled={busy}>
            {busy ? "Hledám…" : "Hledat"}
          </button>
        </div>
      </form>

      {error && <div className="error">{error}</div>}

      {searched && hits.length === 0 && !busy && (
        <div className="notice">Žádné výsledky. Zkus jiný dotaz nebo režim.</div>
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
