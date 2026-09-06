import test from 'node:test';
import assert from 'node:assert/strict';

import { checkRegion, classify, missingPermissions, isServiceDisabled } from '../src/checks.js';

/** The exact shape Vertex returns when a service account has no project IAM. */
const denied = (permission, region) => ({
  status: 403,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  data: {
    error: {
      code: 403,
      message:
        `Permission '${permission}' denied on resource ` +
        `'//aiplatform.googleapis.com/projects/demo/locations/${region}' (or it may not exist).`,
    },
  },
  config: { metadata: { url: `https://${region}-aiplatform.googleapis.com/...` } },
});

const okJson = (data = {}) => ({
  status: 200,
  headers: { 'content-type': 'application/json; charset=UTF-8' },
  data,
  config: { metadata: { url: 'https://me-west1-aiplatform.googleapis.com/...' } },
});

/** A stub axios that answers per-URL and records what was called. */
function stubHttp(routes) {
  const calls = [];
  const answer = (url) => {
    calls.push(url);
    const hit = routes.find(([pattern]) => pattern.test(url));
    if (!hit) throw new Error(`unexpected request: ${url}`);
    return Promise.resolve(hit[1]);
  };
  return { calls, get: (url) => answer(url), post: (url) => answer(url) };
}

test('a project-wide IAM denial is named by permission, not repeated as a wall of text', () => {
  const verdict = classify([
    { name: 'location', status: 403, ok: false, error: denied('aiplatform.locations.get', 'me-west1').data.error.message },
    { name: 'publisherModels', status: 200, ok: true },
    { name: 'customModels', status: 403, ok: false, error: denied('aiplatform.models.list', 'me-west1').data.error.message },
    { name: 'generateContent', status: 403, ok: false, error: denied('aiplatform.endpoints.predict', 'me-west1').data.error.message },
  ]);

  assert.equal(verdict.status, 'PARTIAL');
  assert.equal(verdict.iamDenied, true);
  assert.equal(
    verdict.detail,
    'credential valid, but the project denies: aiplatform.locations.get, ' +
      'aiplatform.models.list, aiplatform.endpoints.predict',
  );
});

test('inference working outranks the metadata reads being denied', () => {
  const verdict = classify([
    { name: 'location', status: 403, ok: false, error: "Permission 'aiplatform.locations.get' denied on resource '//x'." },
    { name: 'publisherModels', status: 200, ok: true },
    { name: 'customModels', status: 403, ok: false, error: "Permission 'aiplatform.models.list' denied on resource '//x'." },
    { name: 'generateContent', status: 200, ok: true },
  ]);

  assert.equal(verdict.status, 'OK');
  assert.match(verdict.detail, /inference works/);
  assert.match(verdict.detail, /aiplatform\.locations\.get/);
});

test('publisherModels passing on its own is not enough - it is not project-scoped', () => {
  const verdict = classify([
    { name: 'location', status: 403, ok: false, error: "Permission 'aiplatform.locations.get' denied on resource '//x'." },
    { name: 'publisherModels', status: 200, ok: true },
    { name: 'customModels', status: 403, ok: false, error: "Permission 'aiplatform.models.list' denied on resource '//x'." },
    { name: 'generateContent', status: 403, ok: false, error: "Permission 'aiplatform.endpoints.predict' denied on resource '//x'." },
  ]);
  assert.notEqual(verdict.status, 'OK');
});

test('an API that was never enabled is not reported as a missing role', () => {
  const probes = [
    {
      name: 'location',
      status: 403,
      ok: false,
      error: 'Vertex AI API has not been used in project demo before or it is disabled.',
    },
  ];
  assert.equal(isServiceDisabled(probes), true);
  assert.equal(classify(probes).detail, 'the Vertex AI API is not enabled on this project');
  assert.equal(classify(probes).iamDenied, true);
});

test('missingPermissions de-duplicates and ignores non-403 noise', () => {
  assert.deepEqual(
    missingPermissions([
      { status: 403, error: "Permission 'a.b' denied on resource '//x'." },
      { status: 403, error: "Permission 'a.b' denied on resource '//y'." },
      { status: 403, error: "Permission 'c.d' denied on resource '//x'." },
      { status: 404, error: "Permission 'e.f' denied on resource '//x'." },
      { status: 200, ok: true },
    ]),
    ['a.b', 'c.d'],
  );
});

test('a 403 on the reads triggers the inference probe even without --generate', async () => {
  const http = stubHttp([
    [/\/locations\/me-west1$/, denied('aiplatform.locations.get', 'me-west1')],
    [/\/publishers\/google\/models\?/, okJson({ publisherModels: [] })],
    [/\/models\?pageSize=1$/, denied('aiplatform.models.list', 'me-west1')],
    [/:generateContent$/, okJson({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] })],
  ]);

  const result = await checkRegion(http, {
    region: 'me-west1',
    projectId: 'demo',
    auth: { kind: 'bearer', accessToken: 'ya29.x' },
    model: 'gemini-2.5-flash',
    generate: false,
  });

  assert.ok(
    http.calls.some((url) => url.endsWith(':generateContent')),
    'the inference probe should run once the reads are denied',
  );
  assert.equal(result.status, 'OK');
});

test('reads that pass do not trigger an unrequested inference call', async () => {
  const http = stubHttp([
    [/\/locations\/me-west1$/, okJson({ name: 'projects/demo/locations/me-west1' })],
    [/\/publishers\/google\/models\?/, okJson({ publisherModels: [] })],
    [/\/models\?pageSize=1$/, okJson({ models: [] })],
  ]);

  const result = await checkRegion(http, {
    region: 'me-west1',
    projectId: 'demo',
    auth: { kind: 'bearer', accessToken: 'ya29.x' },
    model: 'gemini-2.5-flash',
    generate: false,
  });

  assert.equal(http.calls.filter((url) => url.endsWith(':generateContent')).length, 0);
  assert.equal(result.status, 'OK');
  assert.equal(result.detail, 'all probes passed');
});
