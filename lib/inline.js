/**
 * Host-side relative-asset inlining.
 *
 * The client half cannot reliably reach sibling files (the `remote` workspace
 * service and session-scoped plumbing are version-sensitive), while the host has
 * plain filesystem access. The client posts the previewed document address; the
 * host reads the document, inlines every relative `src`/`href` as a `data:` URL
 * and returns the finished HTML.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

const INLINE_ROUTE_PATH = '/dsh-pointer/inline';
const INLINE_MAX_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT = {
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

/** Decode a `dsh-resource://file/…` address into `{ scope, sessionId, path }`. */
function parseResourceAddress(address) {
  const prefix = 'dsh-resource://file/';
  if (typeof address !== 'string' || !address.startsWith(prefix)) return null;
  let rest = address.slice(prefix.length);
  const cut = rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  const parts = rest.split('/');
  const scope = parts.shift();
  try {
    if (scope === 'session') {
      const id = parts.shift();
      if (!id || parts.length === 0) return null;
      return {
        scope,
        sessionId: decodeURIComponent(id),
        path: parts.map((segment) => decodeURIComponent(segment)).join('/'),
      };
    }
    if (scope === 'absolute') {
      const unc = parts[0] === '' && parts.length > 1;
      const segments = (unc ? parts.slice(1) : parts).map((segment) => decodeURIComponent(segment));
      if (segments.length === 0 || segments[0] === '') return null;
      if (unc) return { scope, sessionId: null, path: '//' + segments.join('/') };
      const path = /^[A-Za-z]:$/.test(segments[0]) ? segments.join('/') : '/' + segments.join('/');
      return { scope, sessionId: null, path };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve the previewed document to a host path.
 *
 * Session addresses are relative to the SESSION workspace, which is not the
 * host's own cwd (that is the profile directory), so the client passes it.
 */
function resolveDocumentPath(address, cwd, explicitPath) {
  // The client may know the absolute path from the tab metadata; trust it when
  // it really is absolute, otherwise fall back to the address scopes.
  if (typeof explicitPath === 'string' && explicitPath.length > 0) {
    const absolute = /^[A-Za-z]:[\\/]/.test(explicitPath) || explicitPath.startsWith('\\\\');
    if (absolute) return resolve(explicitPath);
  }
  const parsed = parseResourceAddress(address);
  if (!parsed) return null;
  if (parsed.scope === 'absolute') return resolve(parsed.path);
  const root = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
  return resolve(join(root, parsed.path));
}

function isRelativeRef(value) {
  const ref = String(value || '').trim();
  if (!ref) return false;
  if (ref.startsWith('#') || ref.startsWith('//')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return false;
  return true;
}

function mimeOf(path) {
  const ext = extname(String(path).split('?')[0].split('#')[0]).replace(/^\./, '').toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Inline `url(...)` references inside a stylesheet, resolved against its own directory. */
async function inlineCssUrls(cssText, cssDir, budget) {
  const urls = [...String(cssText).matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]);
  let out = String(cssText);
  let spent = 0;
  for (const raw of new Set(urls)) {
    if (!isRelativeRef(raw)) continue;
    if (budget.spent + spent > INLINE_MAX_BYTES) break;
    try {
      const file = resolve(cssDir, raw.split('#')[0].split('?')[0]);
      const bytes = await readFile(file);
      spent += bytes.length;
      out = out.split(raw).join('data:' + mimeOf(file) + ';base64,' + bytes.toString('base64'));
    } catch {
      /* keep the original reference */
    }
  }
  budget.spent += spent;
  return out;
}

/** Read the document and inline every relative asset it references. */
export async function inlineDocument(address, options) {
  const filePath = resolveDocumentPath(address, options && options.cwd, options && options.path);
  if (!filePath) return { ok: false, error: 'unrecognised resource address' };
  // Guard: a very large document costs host memory roughly 6x its size, so the
  // caller can cap it and report a buildable message instead of hanging.
  if (options && typeof options.maxBytes === 'number' && options.maxBytes > 0) {
    try {
      const info = await stat(filePath);
      if (info.size > options.maxBytes) {
        return {
          ok: false,
          error: 'file-too-large',
          stats: { document: filePath, size: info.size, limit: options.maxBytes },
        };
      }
    } catch {
      /* stat failure falls through to the read error below */
    }
  }

  let html;
  try {
    html = await readFile(filePath, 'utf8');
  } catch (error) {
    return { ok: false, error: 'cannot read document: ' + String(error && error.message ? error.message : error) };
  }

  // Line mapping needs the ORIGINAL text; skip it for very large documents.
  const SOURCE_MAX = 8 * 1024 * 1024;
  const source = options && options.includeSource && html.length <= SOURCE_MAX ? html : null;

  const dir = dirname(filePath);
  const attrRe = /\b(src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const refs = new Map();
  for (const match of html.matchAll(attrRe)) {
    const raw = match[3] ?? match[4] ?? match[5] ?? '';
    if (!isRelativeRef(raw)) continue;
    const clean = raw.split('#')[0].split('?')[0];
    if (!clean || refs.has(raw)) continue;
    refs.set(raw, clean);
  }

  const budget = { spent: 0 };
  const failures = [];
  const pairs = [];
  let inlined = 0;
  let out = html;

  for (const [raw, clean] of refs) {
    if (budget.spent > INLINE_MAX_BYTES) {
      failures.push('budget exhausted before ' + clean);
      break;
    }
    const target = resolve(dir, clean);
    const mime = mimeOf(target);
    try {
      const bytes = await readFile(target);
      if (bytes.length === 0) continue;
      budget.spent += bytes.length;
      inlined += 1;
      if (mime === 'text/css') {
        const css = await inlineCssUrls(bytes.toString('utf8'), dirname(target), budget);
        const linkRe = new RegExp('<link[^>]*href\\s*=\\s*["\']' + escapeRegExp(raw) + '["\'][^>]*>', 'i');
        out = out.replace(linkRe, () => '<style>' + css.replace(/<\/style/gi, '<\\/style') + '</style>');
      } else {
        const dataUrl = 'data:' + mime + ';base64,' + bytes.toString('base64');
        pairs.push([raw, dataUrl]);
        out = out.split(raw).join(dataUrl);
      }
    } catch (error) {
      failures.push(clean + ': ' + String(error && error.message ? error.message : error).slice(0, 120));
    }
  }

  return {
    ok: true,
    html: out,
    source,
    // raw -> data URL, so the client can map a rendered element back to source
    pairs,
    stats: {
      document: filePath,
      cwd: (options && options.cwd) || null,
      attempted: refs.size,
      inlined,
      bytes: budget.spent,
      failures: failures.slice(0, 5),
    },
  };
}

export { INLINE_ROUTE_PATH };
