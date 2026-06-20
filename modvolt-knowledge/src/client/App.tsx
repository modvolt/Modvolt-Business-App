import React, { useState } from "react";
import { AuthProvider, useAuth } from "./lib/auth.js";
import { Layout, type Page } from "./components/Layout.js";
import { LoginPage } from "./pages/LoginPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { SearchPage } from "./pages/SearchPage.js";
import { ChatPage } from "./pages/ChatPage.js";
import { DocumentsPage } from "./pages/DocumentsPage.js";
import { CategoriesPage } from "./pages/CategoriesPage.js";
import { TagsPage } from "./pages/TagsPage.js";
import { IndexingPage } from "./pages/IndexingPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import { CsnLockPage } from "./pages/CsnLockPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { UsersPage } from "./pages/UsersPage.js";

function Shell() {
  const { user, loading } = useAuth();
  const [page, setPage] = useState<Page>("dashboard");

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="spinner">Načítám…</div>
      </div>
    );
  }

  if (!user) return <LoginPage />;

  const isAdmin = user.role === "admin";

  return (
    <Layout page={page} onNavigate={setPage}>
      {page === "dashboard" && <DashboardPage />}
      {page === "chat" && <ChatPage />}
      {page === "search" && <SearchPage />}
      {page === "documents" && <DocumentsPage />}
      {page === "categories" && isAdmin && <CategoriesPage />}
      {page === "tags" && isAdmin && <TagsPage />}
      {page === "indexing" && isAdmin && <IndexingPage />}
      {page === "audit" && isAdmin && <AuditPage />}
      {page === "csn-lock" && isAdmin && <CsnLockPage />}
      {page === "settings" && isAdmin && <SettingsPage />}
      {page === "users" && isAdmin && <UsersPage />}
    </Layout>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
