import { urls, hostForRegion } from './regions.js';
import { authHeaders } from './auth.js';

/**
 * Per-region probes, cheapest first.
 *
 *   1. location         GET  /v1/projects/{p}/locations/{region}
 *   2. publisherModels  GET  /v1beta1/publishers/google/models
 *   3. customModels     GET  /v1/projects/{p}/locations/{region}/models
 *   4. generateContent  POST .../publishers/google/models/{model}:generateContent
 *
 * Note that probe 2 is NOT project-scoped - there is no project in its path -
 * so it passing proves the token is accepted, and nothing about the project.
 * Only probes 1, 3 and 4 exercise IAM on the project itself, and they need
 * three *different* permissions: locations.get, models.list and
 * endpoints.predict. A key can be denied the first two and still be perfectly
 * able to run inference, which is why probe 4 runs automatically whenever the
 * reads come back 403 - otherwise the verdict would be inconclusive exactly
 * where it matters.
 *
 * A region is OK when inference works (or every probe passed), PARTIAL when
 * the endpoint answers and the credential is valid but the project is not
 * usable, and FAIL when the key or the region does not work at all.
 */

export async function checkRegion(http, { region, projectId, auth, model, generate }) {
  const host = hostForRegion(region);
  const started = Date.now();
  const probes = [];

  const run = async (name, requestFn) => {
    try {
      const response = await requestFn();
      const probe = {
        name,
        url: response.config?.metadata?.url ?? '',
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        // An HTML body from *-aiplatform.googleapis.com means we never reached
        // the API at all - typically a region name that does not exist.
        html: /text\/html/i.test(response.headers?.['content-type'] || ''),
        error: response.status >= 300 ? extractError(response.data) : null,
      };
      probes.push(probe);
      return probe;
    } catch (err) {
      const probe = { name, status: null, ok: false, error: networkError(err), transport: true };
      probes.push(probe);
      return probe;
    }
  };

  const { headers } = authHeaders(auth);
  const withAuth = { headers };

  // 1. Does this regional host exist and does it accept our credential at all?
  const location = await run('location', () =>
    http.get(urls.location(region, projectId), withAuth),
  );

  // A DNS failure, or an HTML error page instead of a JSON API error, both mean
  // the region name itself is wrong - no point running the remaining probes.
  if (location.transport && /ENOTFOUND|EAI_AGAIN/.test(location.error)) {
    return finish({
      region,
      host,
      probes,
      started,
      status: 'FAIL',
      detail: `host does not resolve - "${region}" is not a Vertex AI region`,
    });
  }
  if (location.html) {
    return finish({
      region,
      host,
      probes,
      started,
      status: 'FAIL',
      detail: `got an HTML error page, not the API - "${region}" is not a Vertex AI region`,
    });
  }

  // 2. Which Gemini/publisher models this region serves.
  await run('publisherModels', () => http.get(urls.publisherModels(region), withAuth));

  // 3. Project-scoped read: proves the key has IAM on the project, not just a valid signature.
  const customModels = await run('customModels', () =>
    http.get(urls.customModels(region, projectId), withAuth),
  );

  // 4. A real inference round-trip. Asked for with --generate, and run anyway
  //    when the reads were denied: endpoints.predict is a separate permission,
  //    and it is the one that decides whether the key is actually usable.
  const readsDenied = [location, customModels].some((p) => p.status === 403);
  if (generate || readsDenied) {
    await run('generateContent', () =>
      http.post(
        urls.generateContent(region, projectId, model),
        {
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }],
          generationConfig: { maxOutputTokens: 16, temperature: 0 },
        },
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      ),
    );
  }

  return finish({ region, host, probes, started, ...classify(probes) });
}

function finish({ region, host, probes, started, status, detail, iamDenied = false }) {
  return { region, host, probes, status, detail, iamDenied, ms: Date.now() - started };
}

/** Probes that actually exercise IAM on the project. */
const PROJECT_SCOPED = ['location', 'customModels', 'generateContent'];

/** Pulls "aiplatform.locations.get" out of a Google permission-denied message. */
export function deniedPermission(message) {
  return /Permission '([^']+)' denied/.exec(message || '')?.[1] ?? null;
}

/** Every distinct permission the project refused, in probe order. */
export function missingPermissions(probes) {
  const names = probes
    .filter((p) => p.status === 403)
    .map((p) => deniedPermission(p.error))
    .filter(Boolean);
  return [...new Set(names)];
}

/** A 403 that means "turn the API on", not "grant a role". */
export function isServiceDisabled(probes) {
  return probes.some((p) => /has not been used in project|SERVICE_DISABLED|is disabled/i.test(p.error || ''));
}

/** Turns the probe results into one verdict plus a human sentence. */
export function classify(probes) {
  const by = Object.fromEntries(probes.map((p) => [p.name, p]));
  const anyOk = probes.some((p) => p.ok);
  const projectProbes = probes.filter((p) => PROJECT_SCOPED.includes(p.name));

  if (probes.some((p) => p.status === 401)) {
    return { status: 'FAIL', detail: 'HTTP 401 - the credential was rejected (expired or invalid)' };
  }

  if (probes.length && probes.every((p) => p.transport)) {
    return { status: 'FAIL', detail: probes[0]?.error || 'no response from the endpoint' };
  }

  if (isServiceDisabled(probes)) {
    return {
      status: 'PARTIAL',
      detail: 'the Vertex AI API is not enabled on this project',
      iamDenied: true,
    };
  }

  // Inference working is the answer that matters, even if the metadata reads
  // were denied - those permissions are not needed to use a model.
  if (by.generateContent?.ok) {
    const denied = missingPermissions(probes);
    return {
      status: 'OK',
      detail: denied.length
        ? `inference works; read-only IAM missing (${denied.join(', ')})`
        : 'all probes passed',
    };
  }

  const failed = probes.filter((p) => !p.ok);
  if (failed.length === 0) {
    return { status: 'OK', detail: 'all probes passed' };
  }

  const denied = missingPermissions(probes);
  if (denied.length && projectProbes.every((p) => !p.ok)) {
    return {
      status: anyOk ? 'PARTIAL' : 'FAIL',
      // Project IAM is not per-region, so this verdict holds for every region.
      detail: `credential valid, but the project denies: ${denied.join(', ')}`,
      iamDenied: true,
    };
  }

  if (by.location?.ok || by.publisherModels?.ok) {
    return {
      status: 'PARTIAL',
      detail: `${failed.map((p) => `${p.name}:${p.status ?? 'ERR'}`).join(', ')} - ${
        failed[0].error || 'see --verbose'
      }`,
    };
  }

  return {
    status: 'FAIL',
    detail: `${failed[0].name} -> ${failed[0].status ?? 'ERR'} ${failed[0].error || ''}`.trim(),
  };
}

/** Express mode: API key + the global endpoint, used as the last-resort fallback. */
export async function checkExpressMode(http, { auth, model }) {
  const started = Date.now();
  const { headers } = authHeaders(auth);
  try {
    const response = await http.post(
      urls.expressGenerateContent(model),
      {
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: OK' }] }],
        generationConfig: { maxOutputTokens: 16, temperature: 0 },
      },
      { headers: { ...headers, 'Content-Type': 'application/json' } },
    );
    const ok = response.status >= 200 && response.status < 300;
    return {
      region: 'global (express)',
      host: 'https://aiplatform.googleapis.com',
      probes: [{ name: 'expressGenerateContent', status: response.status, ok }],
      status: ok ? 'OK' : 'FAIL',
      detail: ok ? 'express mode works' : extractError(response.data) || `HTTP ${response.status}`,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      region: 'global (express)',
      host: 'https://aiplatform.googleapis.com',
      probes: [],
      status: 'FAIL',
      detail: networkError(err),
      ms: Date.now() - started,
    };
  }
}

export function extractError(data) {
  if (!data) return null;
  if (typeof data === 'string') {
    // Google's edge returns an HTML page for a host that is not an API host.
    if (/<html/i.test(data)) return 'non-JSON HTML response from the endpoint';
    return oneLine(data);
  }
  const message = data.error?.message || data.message;
  if (!message) return oneLine(JSON.stringify(data));
  return oneLine(message);
}

/** Error text goes into a one-line table cell, so collapse and clip it. */
function oneLine(text, max = 160) {
  return truncate(String(text).replace(/\s+/g, ' ').trim(), max);
}

function networkError(err) {
  if (err.code === 'ECONNABORTED') return 'timed out';
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return `${err.code} - DNS lookup failed`;
  return `${err.code || 'ERROR'} - ${err.message}`;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
