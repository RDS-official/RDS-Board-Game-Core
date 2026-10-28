import fs from 'node:fs';
import path from 'node:path';

/**
 * Export the design tokens as a W3C DTCG document.
 *
 * The web app consumes the tokens as CSS custom properties, but a future native
 * or desktop shell (Electron/Tauri, React Native, SwiftUI) needs them as data.
 * DTCG is the interchange format those targets can read, so this keeps one
 * source of truth instead of a second hand-maintained palette.
 *
 *   node scripts/export-design-tokens.mjs            # write build/design-tokens.json
 *   node scripts/export-design-tokens.mjs --check    # fail if the file is stale
 *   node scripts/export-design-tokens.mjs --stdout   # print instead of writing
 */

const UI_DIR = 'apps/web/src/ui';
const SHEETS = ['tokens/primitives.css', 'tokens/semantic.css', 'tokens/themes.css'];
const OUT = 'build/design-tokens.json';

const args = new Set(process.argv.slice(2));

/** Walks a stylesheet and yields { token, value, selector } per declaration. */
function scan(src) {
  const out = [];
  let depth = 0;
  let buffer = '';
  let selector = '';
  let inComment = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '{') {
      selector = buffer.trim();
      buffer = '';
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      buffer = '';
      continue;
    }
    if (ch === ';') {
      const decl = buffer.trim();
      buffer = '';
      const m = decl.match(/^(--[a-z0-9-]+)\s*:\s*([\s\S]+)$/i);
      if (m) out.push({ token: m[1], value: m[2].trim(), selector });
      continue;
    }
    buffer += ch;
  }
  return out;
}

/** Splits `--surface-panel` into DTCG's nested group path. */
function pathOf(token) {
  return token.replace(/^--/, '').split('-');
}

/**
 * `--surface-panel` and `--surface-panel-solid` split into the same group path,
 * so a naive nested write drops one of them. DTCG reserves `$root` for exactly
 * that case: a node that is both a value and a group.
 */
function setDeep(root, keys, node) {
  let cursor = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    if ('$value' in cursor[key]) cursor[key] = { $root: cursor[key] };
    cursor = cursor[key];
  }
  const leafKey = keys[keys.length - 1];
  const existing = cursor[leafKey];
  if (existing && typeof existing === 'object' && !('$value' in existing)) {
    existing.$root = node;
    return;
  }
  cursor[leafKey] = node;
}

/** DTCG wants a typed value, not a raw CSS string. */
function typedValue(value) {
  const v = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return { $type: 'color', $value: v };
  if (/^(rgba?|hsla?)\(/i.test(v)) return { $type: 'color', $value: v };
  if (/^-?[0-9.]+px$/.test(v)) return { $type: 'dimension', $value: v };
  if (/^-?[0-9.]+rem$/.test(v)) return { $type: 'dimension', $value: v };
  if (/^-?[0-9.]+ms$/.test(v)) return { $type: 'duration', $value: v };
  if (/^-?[0-9.]+s$/.test(v)) return { $type: 'duration', $value: v };
  if (/^(clamp|calc|min|max)\(/.test(v)) return { $type: 'dimension', $value: v, $extensions: { 'rds.function': true } };
  if (/^var\(/.test(v)) return { $value: v, $extensions: { 'rds.alias': true } };
  if (/^-?[0-9.]+$/.test(v)) return { $type: 'number', $value: Number(v) };
  if (/cubic-bezier|ease|linear|steps/.test(v)) return { $type: 'cubicBezier', $value: v };
  return { $value: v };
}

/* ---- collect ----------------------------------------------------------- */
const primitives = {};
const semantic = {};
const themes = {};
const skippedAliases = [];

for (const sheet of SHEETS) {
  const src = fs.readFileSync(path.join(UI_DIR, sheet), 'utf8');
  for (const { token, value, selector } of scan(src)) {
    const keys = pathOf(token);
    if (/\[data-theme/.test(selector)) {
      const theme = selector.match(/data-theme=['"]?([a-z0-9-]+)/i)?.[1] ?? 'unknown';
      themes[theme] ??= {};
      setDeep(themes[theme], keys, typedValue(value));
      continue;
    }
    if (sheet.includes('primitives')) setDeep(primitives, keys, typedValue(value));
    else setDeep(semantic, keys, typedValue(value));
  }
}

/* ---- report ------------------------------------------------------------ */
const count = node =>
  node && typeof node === 'object'
    ? Object.values(node).reduce((sum, child) => sum + ('$value' in child ? 1 : count(child)), 0)
    : 0;

const doc = {
  $description:
    'RDS-Board-Core design tokens. Generated from apps/web/src/ui/tokens/*.css — do not edit by hand.',
  $extensions: {
    'rds.generatedBy': 'scripts/export-design-tokens.mjs',
    'rds.format': 'W3C Design Tokens Community Group'
  },
  primitives,
  semantic,
  themes
};

const json = JSON.stringify(doc, null, 2) + '\n';

if (args.has('--stdout')) {
  process.stdout.write(json);
} else if (args.has('--check')) {
  // Compare with normalised line endings. git's autocrlf rewrites the checked-in
  // file to CRLF on Windows while the generator emits LF, so a raw string
  // compare reports "stale" for a byte-identical document.
  const normalise = text => text.replace(/\r\n/g, '\n');
  const current = fs.existsSync(OUT) ? normalise(fs.readFileSync(OUT, 'utf8')) : '';
  if (current !== normalise(json)) {
    console.log(`design tokens are stale: run "node scripts/export-design-tokens.mjs"`);
    process.exitCode = 1;
  } else {
    console.log('design tokens are up to date.');
  }
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(
    `design tokens exported: ${OUT} ` +
      `(${count(primitives)} primitives, ${count(semantic)} semantic, ` +
      `${Object.keys(themes).length} themes)`
  );
}
