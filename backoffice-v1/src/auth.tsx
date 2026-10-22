import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApiClient, type Admin, type ApiClient } from './api';

const TOKEN_KEY = 'olla.backoffice.token';

type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  admin: Admin | null;
  api: ApiClient;
  login: (loginId: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 저장소를 쓸 수 없으면 이번 탭에서만 로그인 상태를 유지한다. */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const tokenRef = useRef<string | null>(readToken());
  const [status, setStatus] = useState<AuthStatus>(tokenRef.current ? 'loading' : 'anonymous');
  const [admin, setAdmin] = useState<Admin | null>(null);

  const logout = useCallback(() => {
    tokenRef.current = null;
    writeToken(null);
    setAdmin(null);
    setStatus('anonymous');
  }, []);

  const api = useMemo(() => createApiClient(() => tokenRef.current, logout), [logout]);

  useEffect(() => {
    if (!tokenRef.current) return;
    api
      .get<Admin>('/admin/auth/me')
      .then((me) => {
        setAdmin(me);
        setStatus('authenticated');
      })
      .catch(() => logout());
  }, [api, logout]);

  const login = useCallback(
    async (loginId: string, password: string) => {
      const result = await api.post<{ accessToken: string; admin: Admin }>('/admin/auth/login', { loginId, password });
      tokenRef.current = result.accessToken;
      writeToken(result.accessToken);
      setAdmin(result.admin);
      setStatus('authenticated');
    },
    [api],
  );

  const value = useMemo(() => ({ status, admin, api, login, logout }), [status, admin, api, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider 안에서만 사용할 수 있습니다.');
  return value;
}
