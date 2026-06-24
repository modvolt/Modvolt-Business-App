import React, { useEffect, useState } from "react";
import { api, type IndexingJobRow } from "../lib/api.js";
import type { AiDiagnostics, AiCheckResult } from "../../shared/types.js";

const STATUS_BADGE: Record<string, string> = {
  queued: "",
  processing: "",
  done: "indexed",
  failed: "failed",
};

function StatusBadge({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span className={`badge ${ok ? "indexed" : "failed"}`}>
      {label ?? (ok ? "OK" : "Chyba")}
    </span>
  );
}

function CheckRow({
  label,
  result,
}: {
  label: string;
  result: AiCheckResult;
}) {
  return (
    <tr>
      <td>{label}</td>
      <td>
        <StatusBadge ok={result.ok} />
        {!result.ok && result.cause && (
          <div className="tag" style={{ color: "var(--danger, #c0392b)" }}>
            {result.cause}
          </div>
        )}
      </td>
    </tr>
  );
}

function DiagnosticsPanel() {
  const [diag, setDiag] = useState<AiDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    setError("");
    api
      .aiDiagnostics()
      .then(setDiag)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const dimOk = diag?.dimensionMatch === true;

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.1rem" }}>Diagnostika AI</h2>
        <button className="ghost" onClick={load} disabled={loading}>
          {loading ? "Kontroluji…" : "Zkontrolovat"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {diag && (
        <table>
          <tbody>
            <tr>
              <td>OpenAI zapnuto</td>
              <td>
                <StatusBadge
                  ok={diag.openaiEnabled}
                  label={diag.openaiEnabled ? "Ano" : "Ne"}
                />
              </td>
            </tr>
            <tr>
              <td>API klíč nastaven</td>
              <td>
                <StatusBadge
                  ok={diag.hasKey}
                  label={diag.hasKey ? "Ano" : "Ne"}
                />
              </td>
            </tr>
            <tr>
              <td>Chat model</td>
              <td className="tag">{diag.chatModel}</td>
            </tr>
            <CheckRow label="Test chat modelu" result={diag.chatTest} />
            <tr>
              <td>Embedding model</td>
              <td className="tag">{diag.embeddingModel}</td>
            </tr>
            <CheckRow
              label="Test embedding modelu"
              result={diag.embeddingTest}
            />
            <tr>
              <td>Rozměr vektoru</td>
              <td>
                <StatusBadge
                  ok={dimOk}
                  label={`${
                    diag.actualDimension ?? "?"
                  } / ${diag.expectedDimension}`}
                />
              </td>
            </tr>
            <tr>
              <td>Rozšíření pgvector</td>
              <td>
                <StatusBadge
                  ok={diag.pgvectorAvailable}
                  label={diag.pgvectorAvailable ? "Dostupné" : "Chybí"}
                />
              </td>
            </tr>
            <tr>
              <td>Analýza obrázků</td>
              <td className="tag">
                {diag.imageAnalysisEnabled ? "Zapnuto" : "Vypnuto"}
              </td>
            </tr>
            <tr>
              <td>Počet chunků</td>
              <td className="tag">{diag.counts.chunks}</td>
            </tr>
            <tr>
              <td>Počet embeddingů</td>
              <td className="tag">{diag.counts.embeddings}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

export function IndexingPage() {
  const [jobs, setJobs] = useState<IndexingJobRow[]>([]);
  const [error, setError] = useState("");

  const load = () =>
    api
      .indexingJobs()
      .then((r) => setJobs(r.jobs))
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const retry = async (documentId: string) => {
    await api.retryIndexing(documentId);
    load();
  };

  return (
    <div>
      <h1 className="page-title">Import / Indexace</h1>
      <div className="notice">
        Dokumenty se indexují automaticky po nahrání. Zde sledujete stav fronty a
        můžete znovu spustit indexaci u dokumentů, které selhaly. Pro nahrání nového
        dokumentu přejděte do sekce Dokumenty.
      </div>
      <DiagnosticsPanel />
      {error && <div className="error">{error}</div>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Dokument</th>
              <th>Typ</th>
              <th>Stav</th>
              <th>Pokusy</th>
              <th>Vytvořeno</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>{j.documentTitle || j.documentId.slice(0, 8)}</td>
                <td className="tag">{j.jobType}</td>
                <td>
                  <span className={`badge ${STATUS_BADGE[j.status] ?? ""}`}>
                    {j.status}
                  </span>
                  {j.lastError && (
                    <div className="tag" style={{ color: "var(--danger, #c0392b)" }}>
                      {j.lastError.slice(0, 120)}
                    </div>
                  )}
                </td>
                <td className="tag">{j.attempts}</td>
                <td className="tag">
                  {new Date(j.createdAt).toLocaleString("cs-CZ")}
                </td>
                <td style={{ textAlign: "right" }}>
                  {j.status === "failed" && (
                    <button className="ghost" onClick={() => retry(j.documentId)}>
                      Zkusit znovu
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={6} className="tag">
                  Fronta je prázdná.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
