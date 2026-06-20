import React, { useEffect, useState } from "react";
import { api, type IndexingJobRow } from "../lib/api.js";

const STATUS_BADGE: Record<string, string> = {
  queued: "",
  processing: "",
  done: "indexed",
  failed: "failed",
};

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
