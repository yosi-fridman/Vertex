import fs from 'node:fs';
import path from 'node:path';

/**
 * Figures out *what kind of key* we were handed, without ever printing it.
 *
 * Three shapes are supported:
 *   service_account – a JSON key file (has client_email + private_key)
 *   api_key         – a plain "AIza..." string (Vertex AI express mode)
 *   access_token    – an already-minted OAuth2 bearer token (ya29...)
 */

const SERVICE_ACCOUNT_REQUIRED = ['client_email', 'private_key'];

export class CredentialError extends Error {}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new CredentialError(`Cannot read key file "${file}": ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CredentialError(`Key file "${file}" is not valid JSON: ${err.message}`);
  }
}

function fromServiceAccountObject(json, source) {
  const missing = SERVICE_ACCOUNT_REQUIRED.filter((k) => !json[k]);
  if (missing.length) {
    throw new CredentialError(
      `Service account key from ${source} is missing: ${missing.join(', ')}`,
    );
  }
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(json.private_key)) {
    throw new CredentialError(
      `The private_key in ${source} does not look like a PEM key. ` +
        'If you pasted it into an env var, make sure the \\n escapes survived.',
    );
  }
  const body = json.private_key
    .replace(/-----(BEGIN|END)( RSA)? PRIVATE KEY-----/g, '')
    .replace(/\s|\\n/g, '');
  if (body.length < 100) {
    throw new CredentialError(
      `The private_key in ${source} is only ${body.length} characters - it is a redacted ` +
        'placeholder, not a real key. Use the untouched JSON that Google gave you.',
    );
  }
  return {
    kind: 'service_account',
    source,
    projectId: json.project_id,
    clientEmail: json.client_email,
    privateKey: json.private_key.replace(/\\n/g, '\n'),
    privateKeyId: json.private_key_id,
    tokenUri: json.token_uri || 'https://oauth2.googleapis.com/token',
  };
}

/** Where a key file is looked for when nothing was configured at all. */
export const SECRETS_DIR = 'secrets';
export const DEFAULT_KEY_FILE = 'secrets/vertex-sa.json';

/**
 * Resolution order:
 *   1. --key <file|json>            (explicit wins)
 *   2. GOOGLE_APPLICATION_CREDENTIALS  (path to the JSON key)
 *   3. GOOGLE_SERVICE_ACCOUNT_JSON     (the JSON inline, e.g. from a secret store)
 *   4. GOOGLE_ACCESS_TOKEN             (already-minted bearer token)
 *   5. GOOGLE_API_KEY / VERTEX_API_KEY (express-mode API key)
 *   6. secrets/vertex-sa.json, or the single *.json file in secrets/
 *
 * Step 6 is the "just drop the file in the project" path: put the JSON exactly
 * as Google gave it to you at secrets/vertex-sa.json and run `npm run check`
 * with no flags and no env vars. secrets/ is gitignored.
 */
export function loadCredentials({ keyArg, env = process.env } = {}) {
  if (keyArg) {
    const trimmed = keyArg.trim();
    if (trimmed.startsWith('{')) {
      return fromServiceAccountObject(JSON.parse(trimmed), '--key (inline JSON)');
    }
    if (/^AIza[\w-]{10,}$/.test(trimmed)) {
      return { kind: 'api_key', source: '--key', apiKey: trimmed };
    }
    const file = path.resolve(trimmed);
    return fromServiceAccountObject(readJson(file), file);
  }

  if (env.GOOGLE_APPLICATION_CREDENTIALS) {
    const file = path.resolve(env.GOOGLE_APPLICATION_CREDENTIALS);
    return fromServiceAccountObject(readJson(file), file);
  }

  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    let json;
    try {
      json = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      throw new CredentialError(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${err.message}`);
    }
    return fromServiceAccountObject(json, 'GOOGLE_SERVICE_ACCOUNT_JSON');
  }

  if (env.GOOGLE_ACCESS_TOKEN) {
    return {
      kind: 'access_token',
      source: 'GOOGLE_ACCESS_TOKEN',
      accessToken: env.GOOGLE_ACCESS_TOKEN.trim(),
    };
  }

  const apiKey = env.GOOGLE_API_KEY || env.VERTEX_API_KEY;
  if (apiKey) {
    return {
      kind: 'api_key',
      source: env.GOOGLE_API_KEY ? 'GOOGLE_API_KEY' : 'VERTEX_API_KEY',
      apiKey: apiKey.trim(),
    };
  }

  const discovered = discoverKeyFile(env.VERTEX_SECRETS_DIR || SECRETS_DIR);
  if (discovered) {
    return fromServiceAccountObject(readJson(discovered), discovered);
  }

  throw new CredentialError(
    `No credentials found. Drop your service-account JSON at ${DEFAULT_KEY_FILE} ` +
      '(exactly as Google gave it to you - that directory is gitignored), or set ' +
      'GOOGLE_APPLICATION_CREDENTIALS, or pass --key <file>. See .env.example.',
  );
}

/**
 * Looks for a key file the user simply dropped into secrets/.
 * Prefers the documented name; otherwise accepts a single *.json file there,
 * and refuses to guess when there are several.
 */
export function discoverKeyFile(dir) {
  const preferred = path.resolve(dir, 'vertex-sa.json');
  if (fs.existsSync(preferred)) return preferred;

  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch {
    return null;
  }

  if (entries.length === 0) return null;
  if (entries.length > 1) {
    throw new CredentialError(
      `${dir}/ holds several JSON files (${entries.join(', ')}). ` +
        `Rename the one you want to vertex-sa.json, or pass --key ${dir}/<file>.json.`,
    );
  }
  return path.resolve(dir, entries[0]);
}

/** Never log a secret in full – this is what goes on screen. */
export function describeCredentials(creds) {
  switch (creds.kind) {
    case 'service_account':
      return {
        kind: 'service account (JWT -> OAuth2)',
        source: creds.source,
        identity: creds.clientEmail,
        keyId: creds.privateKeyId ? `${creds.privateKeyId.slice(0, 8)}…` : '(none)',
      };
    case 'api_key':
      return {
        kind: 'API key (express mode)',
        source: creds.source,
        identity: maskSecret(creds.apiKey),
      };
    case 'access_token':
      return {
        kind: 'pre-minted OAuth2 access token',
        source: creds.source,
        identity: maskSecret(creds.accessToken),
      };
    default:
      return { kind: 'unknown', source: creds.source };
  }
}

export function maskSecret(value) {
  if (!value) return '(empty)';
  if (value.length <= 12) return '*'.repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
}
