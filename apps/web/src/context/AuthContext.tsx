import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, setCsrfToken } from '../lib/api';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  roles: string[];
  permissions: string[];
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refreshSession: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    try {
      const data = await apiFetch<{ user: AuthUser; csrfToken: string }>('/api/v1/auth/me');
      setUser(data.user);
      setCsrfToken(data.csrfToken);
    } catch {
      setUser(null);
      setCsrfToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const login = useCallback(
    async (identifier: string, password: string) => {
      const res = await apiFetch<{ csrfToken: string }>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
      });
      setCsrfToken(res.csrfToken);
      await refreshSession();
    },
    [refreshSession],
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
      setCsrfToken(null);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refreshSession, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
