/** Tiny ANSI helpers - no dependency, and they disable themselves when piped. */
const ESC = String.fromCharCode(27);
const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (enabled ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
};

export const ICON = { ok: '✓', fail: '✗', skip: '·', warn: '!' };

export function heading(text) {
  return `\n${c.bold(text)}\n${c.dim('-'.repeat(text.length))}`;
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Renders the per-region summary as an aligned table. */
export function renderSummary(results) {
  const headers = {
    region: 'REGION',
    host: 'ENDPOINT',
    status: 'RESULT',
    ms: 'TIME',
    detail: 'DETAIL',
  };
  const cols = ['region', 'host', 'status', 'ms', 'detail'];

  const rows = results.map((r) => ({
    region: r.region,
    host: r.host.replace('https://', ''),
    status: r.status,
    ms: r.ms == null ? '' : `${r.ms}ms`,
    // The table is read at a glance - the full text stays in --json.
    detail: clip(r.detail || '', 84),
  }));

  const width = {};
  for (const col of cols) {
    width[col] = Math.max(headers[col].length, ...rows.map((r) => String(r[col] ?? '').length));
  }

  const line = (cells, tone) =>
    cols
      .map((col) => {
        const cell = String(cells[col] ?? '').padEnd(width[col]);
        return col === 'status' && tone ? tone(cell) : cell;
      })
      .join('  ');

  const out = [c.dim(line(headers))];
  for (const row of rows) {
    const tone = row.status === 'OK' ? c.green : row.status === 'PARTIAL' ? c.yellow : c.red;
    out.push(line(row, tone));
  }
  return out.join('\n');
}
