import React, { useEffect, useState } from "react";
import { api } from "../lib/api.js";

interface Stats {
  documents: number;
  users: number;
  queries: number;
  categories: number;
  queriesLast30d: number;
  imageQueries: number;
  webQueries: number;
  documentsByStatus: { status: string; c: number }[];
  documentsByType: { documentType: string; c: number }[];
  queriesByMode: { mode: string; c: number }[];
  indexingByStatus: { status: string; c: number }[];
  recentDocuments: {
    id: string;
    title: string;
    status: string;
    documentType: string;
    createdAt: string;
  }[];
  topCategories: { id: string; name: string; c: number }[];
}

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Nahráno",
  processing: "Zpracovává se",
  indexed: "Zaindexováno",
  failed: "Chyba",
  needs_review: "Ke kontrole",
  archived: "Archivováno",
};

export function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .stats()
      .then(setStats)
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) {
    return (
      <div>
        <h1 className="page-title">Přehled</h1>
        <div className="notice">
          Souhrnné statistiky jsou dostupné jen administrátorům.
        </div>
      </div>
    );
  }
  if (!stats) {
    return (
      <div>
        <h1 className="page-title">Přehled</h1>
        <div className="spinner">Načítám…</div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Přehled</h1>

      <div className="row">
        <Metric label="Dokumenty" value={stats.documents} />
        <Metric label="Kategorie" value={stats.categories} />
        <Metric label="Uživatelé" value={stats.users} />
        <Metric label="Dotazy celkem" value={stats.queries} />
      </div>
      <div className="row">
        <Metric label="Dotazy (30 dní)" value={stats.queriesLast30d} />
        <Metric label="Dotazy s fotkou" value={stats.imageQueries} />
        <Metric label="Dotazy s webem" value={stats.webQueries} />
      </div>

      <div className="row">
        <BreakdownCard
          title="Dokumenty podle stavu"
          rows={stats.documentsByStatus.map((r) => ({
            label: STATUS_LABEL[r.status] ?? r.status,
            value: r.c,
          }))}
        />
        <BreakdownCard
          title="Dokumenty podle typu"
          rows={stats.documentsByType.map((r) => ({
            label: r.documentType,
            value: r.c,
          }))}
        />
        <BreakdownCard
          title="Indexovací fronta"
          rows={stats.indexingByStatus.map((r) => ({
            label: r.status,
            value: r.c,
          }))}
        />
      </div>

      <div className="row">
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ marginTop: 0 }}>Naposledy nahrané dokumenty</h3>
          {stats.recentDocuments.length === 0 && (
            <div className="tag">Žádné dokumenty.</div>
          )}
          {stats.recentDocuments.map((d) => (
            <div className="flex-between" key={d.id} style={{ padding: "6px 0" }}>
              <span>{d.title}</span>
              <span className="badge">{STATUS_LABEL[d.status] ?? d.status}</span>
            </div>
          ))}
        </div>
        <BreakdownCard
          title="Nejčastější kategorie"
          rows={stats.topCategories.map((r) => ({ label: r.name, value: r.c }))}
        />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="tag">{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function BreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: number }[];
}) {
  return (
    <div className="card" style={{ flex: 1 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {rows.length === 0 && <div className="tag">Žádná data.</div>}
      {rows.map((r) => (
        <div className="flex-between" key={r.label} style={{ padding: "4px 0" }}>
          <span>{r.label}</span>
          <strong>{r.value}</strong>
        </div>
      ))}
    </div>
  );
}
