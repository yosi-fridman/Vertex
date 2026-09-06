/**
 * Region catalogue for the Vertex AI (Google Cloud AI Platform) REST API.
 *
 * Every regional call goes to a host of the shape:
 *   https://<REGION>-aiplatform.googleapis.com
 * The one exception is the multi-region "global" endpoint:
 *   https://aiplatform.googleapis.com
 */

/** The region the user asked to prefer: Tel Aviv / Middle East. */
export const PREFERRED_REGION = 'me-west1';

/**
 * Ordered fallback list. me-west1 (Tel Aviv) is tried first, then the rest of
 * the Middle East, then the closest European regions, then us-central1 which
 * is where new Vertex models usually land first.
 */
export const DEFAULT_REGIONS = [
  'me-west1',      // Tel Aviv
  'me-central1',   // Doha
  'me-central2',   // Dammam
  'europe-west4',  // Eemshaven
  'europe-west1',  // Saint-Ghislain
  'us-central1',   // Iowa
];

/** Builds the host for a region, e.g. me-west1 -> https://me-west1-aiplatform.googleapis.com */
export function hostForRegion(region) {
  if (!region || region === 'global') return 'https://aiplatform.googleapis.com';
  return `https://${region}-aiplatform.googleapis.com`;
}

/**
 * Full URL of every endpoint this tool touches. Kept in one place on purpose:
 * the point of the tool is to make the URLs visible.
 */
export const urls = {
  /** OAuth2 token exchange for the service-account JWT. */
  token: 'https://oauth2.googleapis.com/token',

  /** GET – the Location resource itself. Cheapest proof that the key + region work. */
  location: (region, projectId) =>
    `${hostForRegion(region)}/v1/projects/${projectId}/locations/${region}`,

  /** GET – Google's publisher models available in that region. */
  publisherModels: (region) =>
    `${hostForRegion(region)}/v1beta1/publishers/google/models?pageSize=5`,

  /** GET – the project's own custom models in that region (exercises IAM on the project). */
  customModels: (region, projectId) =>
    `${hostForRegion(region)}/v1/projects/${projectId}/locations/${region}/models?pageSize=1`,

  /** POST – a real, tiny inference call. Only runs with --generate. */
  generateContent: (region, projectId, model) =>
    `${hostForRegion(region)}/v1/projects/${projectId}/locations/${region}` +
    `/publishers/google/models/${model}:generateContent`,

  /** POST – Vertex AI "express mode": API-key auth, global endpoint, no project in the path. */
  expressGenerateContent: (model) =>
    `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent`,
};
