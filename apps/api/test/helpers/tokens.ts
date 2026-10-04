import { createSign, generateKeyPairSync } from 'node:crypto';

/**
 * Signs Cognito-shaped access tokens with a local test key, so the real
 * aws-jwt-verify checks (signature, issuer, client id, token use, group,
 * expiry) run in tests without any network call.
 */
export const TEST_POOL = { region: 'us-east-1', userPoolId: 'us-east-1_TestPool1', clientId: 'prepress-web-client' };

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const TEST_JWKS = { keys: [{ ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'test-key', alg: 'RS256', use: 'sig' }] } as never;

const b64url = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function signToken(overrides: Record<string, unknown> = {}, opts: { key?: typeof privateKey } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'user-a',
    username: 'alice',
    iss: `https://cognito-idp.${TEST_POOL.region}.amazonaws.com/${TEST_POOL.userPoolId}`,
    client_id: TEST_POOL.clientId,
    token_use: 'access',
    'cognito:groups': ['prepress-reviewers'],
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
  const head = `${b64url({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })}.${b64url(payload)}`;
  const signature = createSign('RSA-SHA256').update(head).sign(opts.key ?? privateKey).toString('base64url');
  return `${head}.${signature}`;
}

export const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
