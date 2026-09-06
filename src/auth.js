import crypto from 'node:crypto';
import { urls } from './regions.js';
import { fullUrl } from './httpClient.js';

/**
 * Turns a credential into the headers/params an aiplatform.googleapis.com call needs.
 *
 * For a service account we do the OAuth2 dance by hand (no google-auth-library)
 * so the token endpoint is as visible as every other URL in this tool:
 *
 *   1. build a JWT  { iss: <client_email>, scope: cloud-platform, aud: <token_uri> }
 *   2. sign it with the private key (RS256)
 *   3. POST it to https://oauth2.googleapis.com/token as a jwt-bearer assertion
 *   4. use the returned access_token as "Authorization: Bearer ..."
 */

export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export class AuthError extends Error {
  constructor(message, { status, data } = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function buildSignedJwt(creds, { now = Math.floor(Date.now() / 1000), lifetime = 3600 } = {}) {
  const header = { alg: 'RS256', typ: 'JWT', kid: creds.privateKeyId };
  const claims = {
    iss: creds.clientEmail,
    sub: creds.clientEmail,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: creds.tokenUri,
    iat: now,
    exp: now + lifetime,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  let signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(creds.privateKey);
  } catch (err) {
    throw new AuthError(
      `Failed to sign the JWT with the private key - the key is malformed: ${err.message}`,
    );
  }

  return `${signingInput}.${base64url(signature)}`;
}

/** Exchanges the signed JWT for an access token. Returns { accessToken, expiresIn, scope }. */
export async function mintAccessToken(http, creds) {
  const assertion = buildSignedJwt(creds);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await http.post(creds.tokenUri || urls.token, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (response.status !== 200 || !response.data?.access_token) {
    throw new AuthError(explainTokenFailure(response), {
      status: response.status,
      data: response.data,
    });
  }

  return {
    accessToken: response.data.access_token,
    expiresIn: response.data.expires_in,
    tokenType: response.data.token_type,
    url: fullUrl({ method: 'post', url: creds.tokenUri || urls.token }),
  };
}

function explainTokenFailure(response) {
  const err = response.data?.error;
  const desc = response.data?.error_description;
  const hints = {
    invalid_grant:
      'the JWT was rejected - usually a revoked/deleted key, a clock skew of more than a few minutes, or a service account that no longer exists',
    invalid_client: 'the client_email in the key file is unknown to Google',
    unauthorized_client: 'the service account is not allowed to request this scope',
  };
  const hint = hints[err] ? ` (${hints[err]})` : '';
  return `Token exchange failed with HTTP ${response.status}: ${err || 'unknown_error'}${
    desc ? ` - ${desc}` : ''
  }${hint}`;
}

/**
 * Builds { headers, params } for an authenticated Vertex call.
 * API keys travel in the x-goog-api-key header (never in the URL) so they do
 * not end up in proxy or server access logs.
 */
export function authHeaders(auth) {
  if (auth.kind === 'api_key') {
    return { headers: { 'x-goog-api-key': auth.apiKey }, params: {} };
  }
  return { headers: { Authorization: `Bearer ${auth.accessToken}` }, params: {} };
}
