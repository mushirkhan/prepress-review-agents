import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { CognitoJwtInvalidGroupError } from 'aws-jwt-verify/error';
import type { Jwks } from 'aws-jwt-verify/jwk';
import type { AppConfig } from './config.js';

export interface User {
  sub: string;
  username: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export type Authenticator = (authorization: string | undefined) => Promise<User>;

/**
 * Verifies Cognito access tokens. The user pool is shared with another app,
 * so a token must be issued to this app's client AND the user must be in the
 * prepress-reviewers group; a valid token for the other app is refused.
 */
export function cognitoAuthenticator(config: AppConfig, opts: { jwks?: Jwks } = {}): Authenticator {
  if (!config.COGNITO_USER_POOL_ID || !config.COGNITO_CLIENT_ID) {
    throw new Error('Cognito auth needs COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID');
  }
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.COGNITO_USER_POOL_ID,
    clientId: config.COGNITO_CLIENT_ID,
    tokenUse: 'access',
    groups: config.COGNITO_REQUIRED_GROUP,
  });
  if (opts.jwks) verifier.cacheJwks(opts.jwks); // tests: no network

  return async (authorization) => {
    const token = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw new AuthError(401, 'Sign in to use this API.');
    try {
      const payload = await verifier.verify(token);
      return { sub: payload.sub, username: String(payload.username ?? payload.sub) };
    } catch (err) {
      if (err instanceof CognitoJwtInvalidGroupError) {
        throw new AuthError(403, `Your account is not in the ${config.COGNITO_REQUIRED_GROUP} group.`);
      }
      throw new AuthError(401, 'Your session is invalid or has expired. Sign in again.');
    }
  };
}

/** Local development only (loadConfig refuses it in production). */
export const devAuthenticator: Authenticator = async () => ({ sub: 'dev-user', username: 'dev' });
