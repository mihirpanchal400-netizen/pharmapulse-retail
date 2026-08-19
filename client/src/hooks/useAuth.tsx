import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, tokenStore, userStore, setSessionExpiredHandler } from '../services/api';
import { setCurrencySymbol } from '../utils/format';
import type { PharmacyProfile, Role, SessionUser } from '../types';

/**
 * Authentication state.
 *
 * The token lives in localStorage so a page refresh does not sign the user out.
 * On mount the stored token is revalidated against /auth/me rather than
 * trusted, so a token that expired while the tab was closed lands the user on
 * the login screen instead of on a dashboard full of failed requests.
 */

interface AuthContextValue {
  user: SessionUser | null;
  profile: PharmacyProfile | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  /** True when the signed-in user holds any of the given roles. */
  can: (...roles: Role[]) => boolean;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => userStore.get<SessionUser>());
  const [profile, setProfile] = useState<PharmacyProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  const loadProfile = useCallback(async () => {
    try {
      const result = await api.get<{ profile: PharmacyProfile }>('/settings');
      setProfile(result.profile);
      setCurrencySymbol(result.profile.currency_symbol);
    } catch {
      // Settings are non-essential for rendering; the app falls back to defaults.
    }
  }, []);

  // The api layer signs the user out when the server rejects a token mid-session.
  useEffect(() => {
    setSessionExpiredHandler(() => setUser(null));
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!tokenStore.get()) {
        setLoading(false);
        return;
      }
      try {
        const result = await api.get<{ user: SessionUser }>('/auth/me');
        if (cancelled) return;
        setUser(result.user);
        userStore.set(result.user);
        await loadProfile();
      } catch {
        if (!cancelled) {
          tokenStore.clear();
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, [loadProfile]);

  const login = useCallback(
    async (username: string, password: string) => {
      const result = await api.post<{ token: string; user: SessionUser }>('/auth/login', {
        username,
        password,
      });
      tokenStore.set(result.token);
      userStore.set(result.user);
      setUser(result.user);
      await loadProfile();
    },
    [loadProfile],
  );

  const can = useCallback(
    (...roles: Role[]) => (user ? roles.includes(user.role) : false),
    [user],
  );

  const value = useMemo(
    () => ({ user, profile, loading, login, logout, can, refreshProfile: loadProfile }),
    [user, profile, loading, login, logout, can, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider.');
  return context;
}
