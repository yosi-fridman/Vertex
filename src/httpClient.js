import axios from 'axios';
import { c } from './report.js';

/**
 * A single axios instance for every call this tool makes.
 *
 * Interceptors print the *full* URL of each request and the status/latency of
 * each response, which is the whole point of the exercise: you should be able
 * to read the terminal and see exactly which https://<region>-aiplatform...
 * endpoint answered and which one did not.
 */
export function createHttpClient({ timeout = 20000, verbose = false, log = console.log } = {}) {
  const http = axios.create({
    timeout,
    // Never throw on an HTTP status – every check inspects the status itself.
    validateStatus: () => true,
    headers: { 'User-Agent': 'vertex-key-check/1.0 (+axios)' },
  });

  http.interceptors.request.use((config) => {
    config.metadata = { start: Date.now(), url: fullUrl(config) };
    log(`  ${c.dim('→')} ${c.bold(config.method.toUpperCase())} ${c.cyan(config.metadata.url)}`);
    if (verbose) {
      log(`    ${c.dim('headers:')} ${c.dim(JSON.stringify(redactHeaders(config.headers)))}`);
      if (config.data) {
        log(`    ${c.dim('body:')} ${c.dim(truncate(stringify(config.data), 400))}`);
      }
    }
    return config;
  });

  http.interceptors.response.use(
    (response) => {
      const ms = Date.now() - (response.config.metadata?.start ?? Date.now());
      const tone = response.status < 300 ? c.green : response.status < 500 ? c.yellow : c.red;
      log(`  ${c.dim('←')} ${tone(String(response.status))} ${c.dim(`${ms}ms`)}`);
      if (verbose) {
        log(`    ${c.dim('body:')} ${c.dim(truncate(stringify(response.data), 600))}`);
      }
      return response;
    },
    (error) => {
      const ms = Date.now() - (error.config?.metadata?.start ?? Date.now());
      log(`  ${c.dim('←')} ${c.red(error.code || 'ERROR')} ${c.dim(`${ms}ms`)} ${error.message}`);
      return Promise.reject(error);
    },
  );

  return http;
}

/** Rebuilds the URL exactly as axios will send it, query string included. */
export function fullUrl(config) {
  const base = config.baseURL ? config.baseURL.replace(/\/$/, '') + config.url : config.url;
  const params = config.params ? new URLSearchParams(config.params).toString() : '';
  const url = params ? `${base}${base.includes('?') ? '&' : '?'}${params}` : base;
  // An API key can legitimately ride in the query string – never print it.
  return url.replace(/([?&]key=)[^&]+/i, '$1***');
}

function redactHeaders(headers) {
  const flat = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || typeof v === 'object') continue;
    flat[k] = /authorization|api-key|goog-api-key/i.test(k) ? '***redacted***' : v;
  }
  return flat;
}

function stringify(data) {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
