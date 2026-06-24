import React, { createContext, useContext, useEffect, useState } from "react";
import { api, type Capabilities } from "./api.js";
import type { SessionUser } from "../../shared/types.js";

interface AuthState {
  user: SessionUser | null;
  capabilities: Capabilities;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities>({
    aiChat: false,
    vision: false,
    webSearch: false,
    ocr: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [me, caps] = await Promise.all([
          api.me().catch(() => ({ user: null })),
          api
            .capabilities()
            .catch(() => ({ aiChat: false, vision: false, webSearch: false, ocr: false })),
        ]);
        setUser((me as any).user ?? null);
        setCapabilities(caps);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api.login(email, password);
    setUser(res.user);
    const caps = await api.capabilities();
    setCapabilities(caps);
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, capabilities, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
