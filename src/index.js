#!/usr/bin/env node
import process from 'node:process';
import { parseArgs, resolveRegionOrder, helpText } from './cli.js';
import { loadCredentials, describeCredentials, CredentialError } from './credentials.js';
import { mintAccessToken, AuthError } from './auth.js';
import { createHttpClient } from './httpClient.js';
import { checkRegion, checkExpressMode } from './checks.js';
import { c, heading, renderSummary, ICON } from './report.js';
import { hostForRegion, PREFERRED_REGION } from './regions.js';

try {
  const { config } = await import('dotenv');
  config({ quiet: true });
} catch {
  // dotenv is optional - env vars set by the shell work just as well.
}

const EXIT = { OK: 0, NO_REGION: 1, USAGE: 2 };

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(c.red(err.message));
    console.error(helpText);
    return EXIT.USAGE;
  }

  if (opts.help) {
    console.log(helpText);
    return EXIT.OK;
  }

  // Quiet the request log when the caller wants JSON on stdout.
  const log = opts.json ? (line) => console.error(line) : (line) => console.log(line);
  const say = opts.json ? () => {} : (line = '') => console.log(line);

  // ---------------------------------------------------------------- credentials
  let creds;
  try {
    creds = loadCredentials({ keyArg: opts.key });
  } catch (err) {
    if (err instanceof CredentialError) {
      console.error(`${c.red(ICON.fail)} ${err.message}`);
      return EXIT.USAGE;
    }
    throw err;
  }

  const projectId =
    opts.project || creds.projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;

  say(heading('Credential'));
  for (const [label, value] of Object.entries(describeCredentials(creds))) {
    say(`  ${c.dim(label.padEnd(9))} ${value}`);
  }
  say(`  ${c.dim('project'.padEnd(9))} ${projectId || c.red('(unknown)')}`);

  if (!projectId && creds.kind !== 'api_key') {
    console.error(
      `\n${c.red(ICON.fail)} No project id. Pass --project <id> or set GOOGLE_CLOUD_PROJECT.`,
    );
    return EXIT.USAGE;
  }

  const http = createHttpClient({ timeout: opts.timeout, verbose: opts.verbose, log });

  // ---------------------------------------------------------------- access token
  let auth;
  if (creds.kind === 'service_account') {
    say(heading('Step 1 - exchange the signed JWT for an access token'));
    try {
      const token = await mintAccessToken(http, creds);
      auth = { kind: 'bearer', accessToken: token.accessToken };
      say(
        `  ${c.green(ICON.ok)} got a ${token.tokenType || 'Bearer'} token, valid for ${
          token.expiresIn
        }s`,
      );
    } catch (err) {
      if (err instanceof AuthError) {
        say(`  ${c.red(ICON.fail)} ${err.message}`);
        if (opts.json) console.log(JSON.stringify({ ok: false, stage: 'token', error: err.message }, null, 2));
        return EXIT.NO_REGION;
      }
      throw err;
    }
  } else if (creds.kind === 'access_token') {
    auth = { kind: 'bearer', accessToken: creds.accessToken };
    say(heading('Step 1 - using the access token as provided (no exchange needed)'));
  } else {
    auth = { kind: 'api_key', apiKey: creds.apiKey };
    say(heading('Step 1 - API key mode (sent as the x-goog-api-key header)'));
  }

  // ---------------------------------------------------------------- regions
  const regionOrder = resolveRegionOrder(opts);
  say(heading(`Step 2 - probe regions (${regionOrder.length} in order, preferred first)`));
  say(`  ${c.dim('order:')} ${regionOrder.join(' -> ')}`);

  const results = [];
  for (const region of regionOrder) {
    say(`\n${c.magenta('▸')} ${c.bold(region)}  ${c.dim(hostForRegion(region))}`);
    const result = await checkRegion(http, {
      region,
      projectId,
      auth,
      model: opts.model,
      generate: opts.generate,
    });
    results.push(result);

    const tone = result.status === 'OK' ? c.green : result.status === 'PARTIAL' ? c.yellow : c.red;
    const icon = result.status === 'OK' ? ICON.ok : result.status === 'PARTIAL' ? ICON.warn : ICON.fail;
    say(`  ${tone(icon)} ${tone(result.status)} - ${result.detail}`);

    // A 401 is the credential itself, not the region - trying more regions
    // would just repeat the same rejection.
    if (result.probes.some((p) => p.status === 401) && !opts.all) {
      say(c.dim('  (the credential was rejected outright - skipping the remaining regions)'));
      break;
    }

    if (result.status === 'OK' && !opts.all) {
      if (region !== regionOrder[0]) {
        say(
          `  ${c.dim(
            `(fell back from ${regionOrder[0]}; stopping here - pass --all to test every region)`,
          )}`,
        );
      }
      break;
    }
  }

  // API keys also work against the global "express mode" endpoint - try it last.
  if (creds.kind === 'api_key' && !results.some((r) => r.status === 'OK')) {
    say(`\n${c.magenta('▸')} ${c.bold('global express mode')}`);
    const express = await checkExpressMode(http, { auth, model: opts.model });
    results.push(express);
    const tone = express.status === 'OK' ? c.green : c.red;
    say(`  ${tone(express.status)} - ${express.detail}`);
  }

  // ---------------------------------------------------------------- verdict
  const working = results.filter((r) => r.status === 'OK');
  const usable = working[0] || results.find((r) => r.status === 'PARTIAL');

  say(heading('Summary'));
  say(renderSummary(results));
  say();

  if (working.length) {
    const winner = working[0];
    say(`${c.green(ICON.ok)} ${c.bold('The key works.')}`);
    say(`  endpoint: ${c.cyan(winner.host)}`);
    say(`  region:   ${c.cyan(winner.region)}`);
    if (winner.region !== PREFERRED_REGION) {
      say(
        c.yellow(
          `  note: ${PREFERRED_REGION} did not answer, this is a fallback region. ` +
            'Data residency may differ from what you wanted.',
        ),
      );
    }
  } else if (usable) {
    say(`${c.yellow(ICON.warn)} ${c.bold('The credential is valid but something is missing.')}`);
    say(`  ${usable.region}: ${usable.detail}`);
    say(c.dim('  Most common cause: the Vertex AI API is not enabled on the project, or the'));
    say(c.dim('  service account lacks roles/aiplatform.user. See README "Troubleshooting".'));
  } else {
    say(`${c.red(ICON.fail)} ${c.bold('No region accepted this key.')}`);
    say(c.dim('  Run again with --verbose to see the full request and response.'));
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: working.length > 0,
          credential: describeCredentials(creds),
          project: projectId ?? null,
          preferredRegion: regionOrder[0],
          selected: working[0]
            ? { region: working[0].region, endpoint: working[0].host }
            : null,
          results,
        },
        null,
        2,
      ),
    );
  }

  return working.length ? EXIT.OK : EXIT.NO_REGION;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(c.red(`Unexpected failure: ${err.stack || err.message}`));
    process.exitCode = EXIT.USAGE;
  });
