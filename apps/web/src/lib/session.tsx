import { createContext, type ReactNode, useContext, useMemo, useRef } from 'react';
import { AuthProvider, useAuth } from 'react-oidc-context';
import { config } from '../config';
import { createApi, type Api } from './api';

export interface Session {
  userName: string;
  getToken: () => Promise<string | undefined>;
  signOut: () => void;
  api: Api;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

const origin = window.location.origin;

/**
 * Cognito hosted sign-in (authorization code + PKCE) through
 * react-oidc-context. Tokens stay in session storage and are renewed
 * silently with the refresh token.
 */
const oidcConfig = {
  authority: config.cognito.authority,
  client_id: config.cognito.clientId,
  redirect_uri: `${origin}/auth/callback`,
  post_logout_redirect_uri: `${origin}/`,
  response_type: 'code',
  scope: 'openid email profile',
  automaticSilentRenew: true,
  onSigninCallback: () => window.history.replaceState({}, '', '/'),
};

function CognitoGate({ children, signIn }: { children: ReactNode; signIn: (start: () => void, error?: string) => ReactNode }) {
  const auth = useAuth();
  const tokenRef = useRef<string | undefined>(undefined);
  tokenRef.current = auth.user?.access_token;

  const session = useMemo<Session | null>(() => {
    if (!auth.isAuthenticated || !auth.user) return null;
    const getToken = async () => tokenRef.current;
    const profile = auth.user.profile;
    return {
      userName: String(profile.email ?? profile['cognito:username'] ?? profile.sub),
      getToken,
      // Cognito's logout endpoint is not the standard OIDC one.
      signOut: () => {
        void auth.removeUser().then(() => {
          window.location.href = `${config.cognito.domain}/logout?client_id=${config.cognito.clientId}&logout_uri=${encodeURIComponent(`${origin}/`)}`;
        });
      },
      api: createApi(getToken),
    };
  }, [auth.isAuthenticated, auth.user?.profile.sub]);

  if (auth.isLoading) return <div className="splash">Signing in…</div>;
  if (!session) return <>{signIn(() => void auth.signinRedirect(), auth.error?.message)}</>;
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** Local development only: no sign-in; the API must run with AUTH_MODE=dev. */
function DevGate({ children }: { children: ReactNode }) {
  const session = useMemo<Session>(() => {
    const getToken = async () => undefined;
    return { userName: 'dev', getToken, signOut: () => window.location.assign('/'), api: createApi(getToken) };
  }, []);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function SessionProvider({ children, signIn }: { children: ReactNode; signIn: (start: () => void, error?: string) => ReactNode }) {
  if (config.authMode === 'dev') return <DevGate>{children}</DevGate>;
  return (
    <AuthProvider {...oidcConfig}>
      <CognitoGate signIn={signIn}>{children}</CognitoGate>
    </AuthProvider>
  );
}
