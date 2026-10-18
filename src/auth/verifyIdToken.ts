import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from '../config.js';

export interface VerifiedUser {
  uid: string;
  /** Display name claim from the token, if the sign-in provider gave one. */
  name: string | null;
}

export type TokenVerifier = (token: unknown) => Promise<VerifiedUser>;

const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/**
 * Verifies a Firebase Auth ID token without a service account:
 * RS256 signature against Google's public keys, issuer + audience = your project id, not expired.
 * `keys` is injectable so tests can use a local key set.
 */
export function createVerifier(projectId: string, keys?: JWTVerifyGetKey): TokenVerifier {
  const keySet = keys ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return async (token) => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
      throw new Error('missing_token');
    }
    const { payload } = await jwtVerify(token, keySet, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    const uid = payload.sub;
    if (typeof uid !== 'string' || uid.length === 0 || uid.length > 128) throw new Error('bad_subject');
    return { uid, name: typeof payload.name === 'string' ? payload.name : null };
  };
}

let override: TokenVerifier | null | undefined; // undefined = use config

/** Tests (or a custom setup) can replace the verifier; `null` forces dev mode (no verification). */
export function setTokenVerifier(v: TokenVerifier | null | undefined): void {
  override = v;
}

let fromConfig: TokenVerifier | null | undefined;

/** null = dev mode: FIREBASE_PROJECT_ID is not set, so identities are NOT verified. */
export function getTokenVerifier(): TokenVerifier | null {
  if (override !== undefined) return override;
  if (fromConfig === undefined) {
    fromConfig = config.firebaseProjectId ? createVerifier(config.firebaseProjectId) : null;
  }
  return fromConfig;
}
