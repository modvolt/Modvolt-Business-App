import React from "react";
import { useAuth } from "../lib/auth.js";

export type Page =
  | "dashboard"
  | "chat"
  | "search"
  | "documents"
  | "categories"
  | "tags"
  | "indexing"
  | "audit"
  | "settings"
  | "users";

export function Layout({
  page,
  onNavigate,
  children,
}: {
  page: Page;
  onNavigate: (p: Page) => void;
  children: React.ReactNode;
}) {
  const { user, capabilities, logout } = useAuth();
  const isAdmin = user?.role === "admin";

  const items: { key: Page; label: string; show: boolean }[] = [
    { key: "dashboard", label: "Přehled", show: true },
    { key: "chat", label: "AI dotaz", show: true },
    { key: "search", label: "Vyhledávání", show: true },
    { key: "documents", label: "Dokumenty", show: true },
    { key: "categories", label: "Kategorie", show: isAdmin },
    { key: "tags", label: "Štítky", show: isAdmin },
    { key: "indexing", label: "Import / Indexace", show: isAdmin },
    { key: "audit", label: "Audit log", show: isAdmin },
    { key: "settings", label: "Nastavení", show: isAdmin },
    { key: "users", label: "Uživatelé", show: isAdmin },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" /> Modvolt Knowledge
        </div>
        {items
          .filter((i) => i.show)
          .map((i) => (
            <button
              key={i.key}
              className={`nav-item ${page === i.key ? "active" : ""}`}
              onClick={() => onNavigate(i.key)}
            >
              {i.label}
            </button>
          ))}
        <div className="sidebar-footer">
          <div>{user?.name}</div>
          <div className="tag">{roleLabel(user?.role)}</div>
          {!capabilities.aiChat && (
            <div className="tag" style={{ marginTop: 8 }}>
              AI vypnuto
            </div>
          )}
          <button
            className="ghost"
            style={{ marginTop: 10, padding: 0 }}
            onClick={() => logout()}
          >
            Odhlásit se
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

function roleLabel(role?: string): string {
  switch (role) {
    case "admin":
      return "Administrátor";
    case "read_only":
      return "Pouze čtení";
    default:
      return "Uživatel";
  }
}
