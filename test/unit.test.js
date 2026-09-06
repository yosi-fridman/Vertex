import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { urls, hostForRegion, DEFAULT_REGIONS, PREFERRED_REGION } from '../src/regions.js';
import { parseArgs, resolveRegionOrder } from '../src/cli.js';
import { buildSignedJwt, CLOUD_PLATFORM_SCOPE, authHeaders } from '../src/auth.js';
import { classify, extractError } from '../src/checks.js';
import { loadCredentials, maskSecret } from '../src/credentials.js';
import { fullUrl } from '../src/httpClient.js';

test('me-west1 is the preferred region and maps to the Tel Aviv host', () => {
  assert.equal(PREFERRED_REGION, 'me-west1');
  assert.equal(hostForRegion('me-west1'), 'https://me-west1-aiplatform.googleapis.com');
  assert.equal(hostForRegion('global'), 'https://aiplatform.googleapis.com');
  assert.equal(DEFAULT_REGIONS[0], 'me-west1');
});

test('endpoint URLs are built exactly as the REST API expects', () => {
  assert.equal(
    urls.location('me-west1', 'demo-proj'),
    'https://me-west1-aiplatform.googleapis.com/v1/projects/demo-proj/locations/me-west1',
  );
  assert.equal(
    urls.publisherModels('me-west1'),
    'https://me-west1-aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=5',
  );
  assert.equal(
    urls.generateContent('me-west1', 'demo-proj', 'gemini-2.5-flash'),
    'https://me-west1-aiplatform.googleapis.com/v1/projects/demo-proj/locations/me-west1' +
      '/publishers/google/models/gemini-2.5-flash:generateContent',
  );
});

test('region order puts the preferred region first and de-duplicates', () => {
  const opts = parseArgs(['--region', 'europe-west4']);
  assert.deepEqual(resolveRegionOrder(opts, {})[0], 'europe-west4');
  assert.equal(new Set(resolveRegionOrder(opts, {})).size, resolveRegionOrder(opts, {}).length);

  assert.deepEqual(resolveRegionOrder(parseArgs([]), {})[0], 'me-west1');
  assert.deepEqual(resolveRegionOrder(parseArgs(['--only-preferred']), {}), ['me-west1']);
  assert.deepEqual(resolveRegionOrder(parseArgs(['--regions', 'a, b ,c']), {}), [
    'me-west1',
    'a',
    'b',
    'c',
  ]);
});

test('parseArgs rejects unknown flags and missing values', () => {
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['--project']), /needs a value/);
  assert.throws(() => parseArgs(['--timeout', '0']), /positive number/);
});

test('the signed JWT verifies against the public key and carries the right claims', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const creds = {
    clientEmail: 'sa@demo-proj.iam.gserviceaccount.com',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    privateKeyId: 'abc123',
    tokenUri: 'https://oauth2.googleapis.com/token',
  };

  const jwt = buildSignedJwt(creds, { now: 1_700_000_000 });
  const [header, claims, signature] = jwt.split('.');

  const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  assert.equal(decode(header).alg, 'RS256');
  assert.equal(decode(claims).iss, creds.clientEmail);
  assert.equal(decode(claims).scope, CLOUD_PLATFORM_SCOPE);
  assert.equal(decode(claims).aud, 'https://oauth2.googleapis.com/token');
  assert.equal(decode(claims).exp - decode(claims).iat, 3600);

  const verified = crypto
    .createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(publicKey, Buffer.from(signature, 'base64url'));
  assert.equal(verified, true);
});

test('a malformed private key fails loudly instead of producing a bad JWT', () => {
  assert.throws(
    () => buildSignedJwt({ clientEmail: 'x@y', privateKey: 'not-a-key', tokenUri: 'u' }),
    /malformed/,
  );
});

test('API keys travel in the header, bearer tokens in Authorization', () => {
  assert.deepEqual(authHeaders({ kind: 'api_key', apiKey: 'AIzaSECRET' }).headers, {
    'x-goog-api-key': 'AIzaSECRET',
  });
  assert.deepEqual(authHeaders({ kind: 'bearer', accessToken: 'ya29.x' }).headers, {
    Authorization: 'Bearer ya29.x',
  });
});

test('classify turns probe results into a verdict', () => {
  assert.equal(classify([{ name: 'location', ok: true, status: 200 }]).status, 'OK');
  assert.equal(classify([{ name: 'location', ok: false, status: 401 }]).status, 'FAIL');
  assert.equal(classify([{ name: 'location', ok: false, status: 403 }]).status, 'FAIL');
  assert.equal(
    classify([
      { name: 'location', ok: true, status: 200 },
      { name: 'customModels', ok: false, status: 403, error: 'permission denied' },
    ]).status,
    'PARTIAL',
  );
});

test('extractError digs the message out of a Google API error body', () => {
  assert.equal(
    extractError({ error: { code: 403, message: 'Permission denied on resource project x.' } }),
    'Permission denied on resource project x.',
  );
  assert.equal(extractError(null), null);
});

test('secrets are masked and API keys never appear in a logged URL', () => {
  assert.equal(maskSecret('AIzaSyABCDEFGHIJKLMNOP'), 'AIzaSy…MNOP (22 chars)');
  assert.match(
    fullUrl({ method: 'get', url: 'https://me-west1-aiplatform.googleapis.com/v1/x?key=SECRET' }),
    /key=\*\*\*$/,
  );
});

test('loadCredentials recognises each credential shape', () => {
  assert.equal(loadCredentials({ keyArg: 'AIzaSyABCDEFGHIJKLMNOP' }).kind, 'api_key');
  assert.equal(
    loadCredentials({ env: { GOOGLE_ACCESS_TOKEN: 'ya29.token' } }).kind,
    'access_token',
  );
  assert.throws(() => loadCredentials({ env: {} }), /No credentials found/);
  assert.throws(
    () =>
      loadCredentials({
        env: { GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"a@b","private_key":"nope"}' },
      }),
    /does not look like a PEM key/,
  );
});
