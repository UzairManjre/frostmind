"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { login as apiLogin, fetchMe } from "./api";

const TOKEN_STORAGE_KEY = "frostmind.adminToken";

interface AuthUser {
  id: string;
  email: string;
  role: string;
}

interface AuthContextValue {
  token: string | null;
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    // Route both branches through a single .finally() callback (rather than an early
    // synchronous setState) so state updates only ever happen inside a promise callback, not
    // directly in the effect body.
    const restore = stored
      ? fetchMe(stored)
          .then((me) => {
            setToken(stored);
            setUser(me);
          })
          .catch(() => {
            window.localStorage.removeItem(TOKEN_STORAGE_KEY);
          })
      : Promise.resolve();
    restore.finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { access_token } = await apiLogin(email, password);
    const me = await fetchMe(access_token);
    window.localStorage.setItem(TOKEN_STORAGE_KEY, access_token);
    setToken(access_token);
    setUser(me);
  }, []);

  const logout = useCallback(() => {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ token, user, loading, login, logout }), [token, user, loading, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
