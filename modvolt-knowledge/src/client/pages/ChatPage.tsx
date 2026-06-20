import React, { useState } from "react";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import type { AiAnswer, SourceMode } from "../../shared/types.js";

const MODES: { key: SourceMode; label: string }[] = [
  { key: "internal_only", label: "Pouze interní" },
  { key: "internal_then_web", label: "Interní + web" },
  { key: "web_allowed", label: "Web povolen" },
  { key: "csn_only", label: "Pouze ČSN/normy" },
];

export function ChatPage() {
  const { capabilities } = useAuth();
  const [query, setQuery] = useState("");
  const [sourceMode, setSourceMode] = useState<SourceMode>("internal_only");
  const [images, setImages] = useState<File[]>([]);
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [meta, setMeta] = useState<{ usedWebSearch: boolean; model: string; promptVersion: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!capabilities.aiChat) {
    return (
      <div>
        <h1 className="page-title">AI asistent</h1>
        <div className="notice">
          AI asistent je momentálně vypnutý. Nastav <code>OPENAI_ENABLED=true</code> a
          platný <code>OPENAI_API_KEY</code>. Aplikace mezitím plně funguje pro
          vyhledávání a správu dokumentů.
        </div>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError("");
    setAnswer(null);
    try {
      const form = new FormData();
      form.append("query", query);
      form.append("sourceMode", sourceMode);
      images.forEach((img) => form.append("images", img));
      const res = await api.ask(form);
      setAnswer(res.answer);
      setMeta({ usedWebSearch: res.usedWebSearch, model: res.model, promptVersion: res.promptVersion });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="page-title">AI asistent</h1>
      <form className="card" onSubmit={submit}>
        <div className="field">
          <textarea
            placeholder="Zeptej se… (např. dimenzování vodičů dle ČSN, zapojení Loxone…)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Režim zdrojů</label>
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
        </div>
        {capabilities.vision && (
          <div className="field">
            <label>Fotografie (volitelné, max 4)</label>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => setImages(Array.from(e.target.files ?? []).slice(0, 4))}
            />
          </div>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Přemýšlím…" : "Odeslat dotaz"}
        </button>
      </form>

      {error && <div className="error">{error}</div>}

      {answer && (
        <div className="card">
          {answer.warnings.map((w, i) => (
            <div className="notice" key={i}>
              {w}
            </div>
          ))}
          {!answer.hasSufficientSources && (
            <div className="notice">
              Dostupné zdroje nemusí být dostatečné pro spolehlivou odpověď.
            </div>
          )}
          <div className="answer-box">{answer.answer}</div>

          {answer.imageObservations && answer.imageObservations.length > 0 && (
            <>
              <h4>Pozorování z fotografií</h4>
              <ul>
                {answer.imageObservations.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            </>
          )}

          {answer.requiredMeasurements && answer.requiredMeasurements.length > 0 && (
            <>
              <h4>Doporučená měření</h4>
              <ul>
                {answer.requiredMeasurements.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </>
          )}

          {answer.citations.length > 0 && (
            <>
              <h4>Citace z interních dokumentů</h4>
              {answer.citations.map((c, i) => (
                <div className="citation" key={i}>
                  <strong>{c.title}</strong>
                  {c.pageNumber ? ` · str. ${c.pageNumber}` : ""}
                  {c.sectionTitle ? ` · ${c.sectionTitle}` : ""}
                  <div className="quote">{c.quote}</div>
                  <div className="tag">{c.reason}</div>
                </div>
              ))}
            </>
          )}

          {answer.webCitations.length > 0 && (
            <>
              <h4>Webové zdroje</h4>
              {answer.webCitations.map((c, i) => (
                <div className="citation" key={i}>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.title}
                  </a>{" "}
                  <span className="tag">
                    {c.domain} · {c.isOfficialSource ? "oficiální" : c.sourceType}
                  </span>
                  <div className="tag">{c.reason}</div>
                </div>
              ))}
            </>
          )}

          <div className="tag" style={{ marginTop: 12 }}>
            Spolehlivost: {answer.confidence} · režim: {answer.sourceMode}
            {meta ? ` · model: ${meta.model} · prompt: ${meta.promptVersion}` : ""}
            {meta?.usedWebSearch ? " · použit web" : ""}
          </div>
        </div>
      )}
    </div>
  );
}
