import React, { useState } from "react";
import { AuthProvider, useAuth } from "./lib/auth.js";
import { Layout, type Page } from "./components/Layout.js";
import { LoginPage } from "./pages/LoginPage.js";
import { SearchPage } from "./pages/SearchPage.js";
import { ChatPage } from "./pages/ChatPage.js";
import { DocumentsPage } from "./pages/DocumentsPage.js";
import { AdminPage } from "./pages/AdminPage.js";

function Shell() {
  const { user, loading } = useAuth();
  const [page, setPage] = useState<Page>("search");

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="spinner">Načítám…</div>
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return (
    <Layout page={page} onNavigate={setPage}>
      {page === "search" && <SearchPage />}
      {page === "chat" && <ChatPage />}
      {page === "documents" && <DocumentsPage />}
      {page === "admin" && user.role === "admin" && <AdminPage />}
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
