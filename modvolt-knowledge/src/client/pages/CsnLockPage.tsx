import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface LockQuery {
  id: string;
  query: string;
  mode: string;
  sourceMode: string | null;
  csnLockTrigger: string | null;
  createdAt: string;
  userName: string | null;
}

const MODE_LABEL: Record<string, string> = {
  ai_chat: "AI dotaz",
  image_chat: "AI dotaz + foto",
  search: "Vyhledávání",
};

export function CsnLockPage() {
  const [queries, setQueries] = useState<LockQuery[]>([]);
  const [total, setTotal] = useState(0);
  const [total30d, setTotal30d] = useState(0);
  const [topTriggers, setTopTriggers] = useState<
    { trigger: string | null; c: number }[]
  >([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .csnLockQueries()
      .then((r) => {
        setQueries(r.queries);
        setTotal(r.total);
        setTotal30d(r.total30d);
        setTopTriggers(r.topTriggers);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoaded(true));
  }, []);

  return (
    <div>
      <h1 className="page-title">Zámek ČSN — spuštěné dotazy</h1>
      <div className="card">
        <div className="notice">
          Přehled reálných dotazů, které byly z bezpečnostních důvodů vynuceně
          přepnuty na režim <code>csn_only</code> (pouze interní normové
          dokumenty, žádný web). U každého dotazu je uvedeno, které klíčové slovo
          nebo vestavěný vzor zámek spustil. Pomáhá najít{" "}
          <strong>falešně pozitivní</strong> spuštění (dotaz, který se zbytečně
          uzamkl kvůli příliš širokému klíčovému slovu) a podle toho upravit
          seznam v <strong>Nastavení</strong>. Spuštění zámku se zaznamenává
          u AI dotazů.
        </div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 8 }}>
          <div>
            <div className="tag">Celkem uzamčeno</div>
            <div style={{ fontSize: "1.6rem", fontWeight: 700 }}>{total}</div>
          </div>
          <div>
            <div className="tag">Za posledních 30 dní</div>
            <div style={{ fontSize: "1.6rem", fontWeight: 700 }}>{total30d}</div>
          </div>
        </div>
      </div>

      {topTriggers.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: "1rem" }}>
            Nejčastější spouštěče
          </h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {topTriggers.map((t) => (
              <span key={t.trigger ?? "?"} className="tag">
                <code>{t.trigger ?? "(neznámé)"}</code> · {t.c}×
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        {error && <div className="error">{error}</div>}
        {loaded && queries.length === 0 && !error && (
          <div className="notice">
            Zatím žádný dotaz nebyl zámkem ČSN uzamčen.
          </div>
        )}
        {queries.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Čas</th>
                <th>Dotaz</th>
                <th>Spouštěč</th>
                <th>Režim</th>
                <th>Uživatel</th>
              </tr>
            </thead>
            <tbody>
              {queries.map((q) => (
                <tr key={q.id}>
                  <td className="tag">
                    {new Date(q.createdAt).toLocaleString("cs-CZ")}
                  </td>
                  <td>{q.query}</td>
                  <td>
                    {q.csnLockTrigger ? (
                      <code>{q.csnLockTrigger}</code>
                    ) : (
                      <span className="tag">—</span>
                    )}
                  </td>
                  <td className="tag">{MODE_LABEL[q.mode] ?? q.mode}</td>
                  <td className="tag">{q.userName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
