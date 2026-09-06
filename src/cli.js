import { DEFAULT_REGIONS, PREFERRED_REGION } from './regions.js';

export const DEFAULT_MODEL = 'gemini-2.5-flash';

const HELP = `
vertex-key-check - does my Google Cloud AI Platform (Vertex AI) key actually work?

Usage:
  node src/index.js [options]

Options:
  --key <file|json>    Service-account JSON file, inline JSON, or an AIza... API key.
                       Defaults to $GOOGLE_APPLICATION_CREDENTIALS.
  --project <id>       GCP project id. Defaults to the project_id in the key file,
                       or $GOOGLE_CLOUD_PROJECT.
  --region <r>         Region to try first. Default: ${PREFERRED_REGION} (Tel Aviv).
  --regions <a,b,c>    Full ordered fallback list. Default: ${DEFAULT_REGIONS.join(',')}
  --only-preferred     Do not fall back - test the preferred region and stop.
  --all                Test every region even after one succeeds.
  --generate           Also send a real generateContent request (costs a few tokens).
  --model <name>       Model for --generate. Default: ${DEFAULT_MODEL}
  --timeout <ms>       Per-request timeout. Default: 20000
  --json               Machine-readable output on stdout.
  --verbose            Print request/response headers and bodies (secrets redacted).
  --help               This text.

Exit codes:
  0  at least one region is fully OK
  1  no region worked
  2  bad usage / bad credentials
`;

export function parseArgs(argv) {
  const opts = {
    key: null,
    project: null,
    region: null,
    regions: null,
    onlyPreferred: false,
    all: false,
    generate: false,
    model: DEFAULT_MODEL,
    timeout: 20000,
    json: false,
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Option ${arg} needs a value`);
      }
      i += 1;
      return value;
    };

    switch (arg) {
      case '--key': opts.key = next(); break;
      case '--project': opts.project = next(); break;
      case '--region': opts.region = next(); break;
      case '--regions': opts.regions = next().split(',').map((r) => r.trim()).filter(Boolean); break;
      case '--only-preferred': opts.onlyPreferred = true; break;
      case '--all': opts.all = true; break;
      case '--generate': opts.generate = true; break;
      case '--model': opts.model = next(); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--json': opts.json = true; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
    throw new Error('--timeout must be a positive number of milliseconds');
  }

  return opts;
}

/** Preferred region first, then the fallback list, de-duplicated. */
export function resolveRegionOrder(opts, env = process.env) {
  const preferred = opts.region || env.VERTEX_REGION || PREFERRED_REGION;
  if (opts.onlyPreferred) return [preferred];
  const rest = opts.regions || DEFAULT_REGIONS;
  return [...new Set([preferred, ...rest])];
}

export const helpText = HELP;
