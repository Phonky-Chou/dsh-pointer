/**
 * dsh-pointer — HOST half.
 *
 * The interactive half lives in ./client.js (registered as a document preview
 * implementation). This host half only provides the *fallback* delivery path:
 * a trust-guarded route plus a systemPrompt context block, so a pick still
 * reaches the agent even if the client-side reference-chip API changes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inlineDocument, INLINE_ROUTE_PATH } from './inline.js';

const STATE_DIR = join(homedir(), '.dsh');
const STATE_PATH = join(STATE_DIR, 'pointer-context.json');
const ROUTE_PATH = '/dsh-pointer/pick';
const BODY_LIMIT = 256 * 1024;
/** Region picks carry several element summaries, so they get a larger cap. */
const PICK_BODY_LIMIT = 2 * 1024 * 1024;

function readItems() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === 'object') : [];
  } catch {
    return [];
  }
}

function writeItems(list) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(list, null, 2) + '\n', 'utf8');
}

function renderOne(item, index) {
  const head = item.label ? item.label : '元素' + (index + 1);
  const loc = item.loc && item.loc.file
    ? item.loc.file + (item.loc.line ? ':' + item.loc.line : '')
    : item.file || '';
  return [
    '<pointer_target' + (item.mode === 'region' ? ' kind="region"' : '') + '>',
    '  Label: ' + head,
    item.source ? '  Page: ' + item.source : null,
    loc ? '  SourceLocation: ' + loc : null,
    item.selector ? '  Selector: ' + item.selector : null,
    item.tag ? '  Tag: <' + item.tag + '>' : null,
    item.text ? '  TextContent: ' + JSON.stringify(item.text) : null,
    item.region ? '  Region: ' + JSON.stringify(item.region) : null,
    Array.isArray(item.items) && item.items.length > 0
      ? '  Contains: ' + item.items.map((x) => x.selector).filter(Boolean).join(' | ')
      : null,
    '  OuterHTML: ' + String(item.outerHTML ?? '').slice(0, 2000),
    '</pointer_target>',
  ].filter(Boolean).join('\n');
}

function render(list) {
  if (list.length === 0) return '';
  return [
    '<pointer_context count="' + list.length + '">',
    ...list.map((item, index) => renderOne(item, index)),
    '</pointer_context>',
  ].join('\n');
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

export const name = 'dsh-pointer';
export const inject = ['systemPrompt', 'webServer', 'connection'];

export function apply(ctx) {
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  ctx.systemPrompt.context({
    name: 'pointer-context',
    order: 121,
    text: () => render(readItems()),
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, { items: readItems() });
        return;
      }
      if (req.method === 'DELETE') {
        writeItems([]);
        sendJson(res, 200, { ok: true, items: [] });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req, PICK_BODY_LIMIT));
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid json body' });
        return;
      }
      // Diagnostics channel: the client reports what the transcript decorator
      // saw, so render-layer failures are observable instead of silent.
      if (parsed && typeof parsed === 'object' && parsed.debug) {
        try {
          mkdirSync(STATE_DIR, { recursive: true });
          writeFileSync(
            join(STATE_DIR, 'pointer-debug.json'),
            JSON.stringify({ at: new Date().toISOString(), debug: parsed.debug }, null, 2) + '\n',
            'utf8',
          );
        } catch {
          /* diagnostics must never fail the request */
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      const incoming = parsed && Array.isArray(parsed.items) ? parsed.items : [];
      const clean = incoming
        .filter((x) => x && typeof x === 'object' && !Array.isArray(x))
        .slice(0, 32);
      const next = parsed && parsed.replace === true ? clean : [...readItems(), ...clean].slice(-32);
      try {
        writeItems(next);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error && error.message) });
        return;
      }
      sendJson(res, 200, { ok: true, items: next });
    },
  }), 'dsh-pointer: pick route');

  // Host-side relative-asset inlining: the client posts the previewed document
  // address and receives finished HTML with every relative src/href as a data URL.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INLINE_ROUTE_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req, BODY_LIMIT));
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid json body' });
        return;
      }
      const address = parsed && typeof parsed.address === 'string' ? parsed.address : '';
      const cwd = parsed && typeof parsed.cwd === 'string' ? parsed.cwd : null;
      const explicitPath = parsed && typeof parsed.path === 'string' ? parsed.path : null;
      let result;
      try {
        result = await inlineDocument(address, {
          cwd,
          path: explicitPath,
          includeSource: parsed && parsed.includeSource === true,
        });
      } catch (error) {
        result = { ok: false, error: String(error && error.message ? error.message : error) };
      }
      try {
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(
          join(STATE_DIR, 'pointer-debug.json'),
          JSON.stringify({
            at: new Date().toISOString(),
            debug: {
              event: 'inline-host',
              address,
              ok: result.ok,
              error: result.error || null,
              stats: result.stats || null,
            },
          }, null, 2) + '\n',
          'utf8',
        );
      } catch {
        /* diagnostics only */
      }
      sendJson(res, 200, result);
    },
  }), 'dsh-pointer: inline route');
}
