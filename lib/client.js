/**
 * dsh-pointer — CLIENT half.
 *
 * Registers its OWN document-preview implementation for html/htm
 * (`priority: 'extension'` ranks above the builtin one, which stays available
 * in the preview dropdown), renders the bytes in a sandboxed srcdoc iframe and
 * injects a self-contained probe. The probe reports picks to this module with
 * `parent.postMessage` — the sandbox stays opaque-origin, so the user's HTML
 * still cannot reach the DSH page.
 *
 * Delivery has two paths: an inline reference chip (primary) and the host
 * route + systemPrompt block (fallback), so a client API change cannot make
 * the feature silently useless.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pointer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PROVIDER_ID = 'dsh-pointer/html';
    /** Compatibility implementation (DSH delivers the bytes itself). */
    const COMPAT_PROVIDER_ID = 'dsh-pointer/html-compat';
    const EXTENSIONS = ['html', 'htm'];
    const TRIGGER = '@';
    const SOURCE_NAME = 'pointer-element';
    const PICK_ROUTE = '/dsh-pointer/pick';
    const SETTINGS_ROUTE = '/dsh-pointer/settings';

    //#region probe (serialized into the sandbox)
    function probeInstall() {
      var KEY = '__DSH_POINTER__';
      if (window[KEY] && window[KEY].v === 1) return;

      var state = { mode: 'off', target: null, dragging: null, justDragged: false };
      var box = null;
      var tag = null;
      var regionEl = null;

      function post(msg) {
        try { msg.v = 1; parent.postMessage(msg, '*'); } catch (e) {}
      }

      function ensureNodes() {
        if (box && box.isConnected) return;
        var host = document.body || document.documentElement;
        if (!host) return;
        box = document.createElement('div');
        box.setAttribute('data-dsh-pointer', 'box');
        box.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;display:none;box-sizing:border-box;outline:2px solid #4f8ef7;outline-offset:-2px;background:rgba(79,142,247,.12)';
        tag = document.createElement('div');
        tag.setAttribute('data-dsh-pointer', 'label');
        tag.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;display:none;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:2px 6px;border-radius:3px;background:#1f2937;color:#e5e7eb;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        regionEl = document.createElement('div');
        regionEl.setAttribute('data-dsh-pointer', 'region');
        regionEl.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;display:none;box-sizing:border-box;border:1px dashed #f59e0b;background:rgba(245,158,11,.12)';
        host.append(box, tag, regionEl);
      }

      function cssEscape(value) {
        return (typeof CSS !== 'undefined' && CSS.escape)
          ? CSS.escape(value)
          : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      }

      function shortName(el) {
        var name = el.tagName ? el.tagName.toLowerCase() : 'node';
        if (el.id) return name + '#' + el.id;
        var cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean)[0] : '';
        return cls ? name + '.' + cls : name;
      }

      function selectorOf(el) {
        var parts = [];
        var node = el;
        while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 8) {
          var name = node.tagName.toLowerCase();
          if (node.id) { parts.unshift(name + '#' + cssEscape(node.id)); break; }
          var classes = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
          var segment = name + classes.map(function (c) { return '.' + cssEscape(c); }).join('');
          var parent = node.parentElement;
          if (parent) {
            var same = 0;
            var index = 0;
            for (var i = 0; i < parent.children.length; i += 1) {
              if (parent.children[i].tagName === node.tagName) {
                same += 1;
                if (parent.children[i] === node) index = same;
              }
            }
            if (same > 1) segment += ':nth-of-type(' + index + ')';
          }
          parts.unshift(segment);
          node = parent;
        }
        return parts.join(' > ');
      }

      function summarize(el) {
        var rect = el.getBoundingClientRect();
        var cs = window.getComputedStyle(el);
        var styles = {};
        var keys = ['display', 'position', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'margin', 'padding', 'border', 'border-radius', 'gap', 'text-align'];
        for (var i = 0; i < keys.length; i += 1) {
          var value = cs.getPropertyValue(keys[i]);
          if (value) styles[keys[i]] = String(value).slice(0, 80);
        }
        return {
          selector: selectorOf(el),
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          id: el.id || '',
          classes: (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 12),
          role: el.getAttribute('role') || '',
          text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          outerHTML: String(el.outerHTML || '').slice(0, 8192),
          rect: {
            x: Math.round(rect.left), y: Math.round(rect.top),
            width: Math.round(rect.width), height: Math.round(rect.height)
          },
          ordinal: (function () {
            try {
              var all = document.querySelectorAll(el.tagName ? el.tagName.toLowerCase() : '*');
              var same = [];
              for (var i = 0; i < all.length; i += 1) {
                if (all[i].outerHTML === el.outerHTML) same.push(all[i]);
              }
              return { index: same.indexOf(el), total: same.length };
            } catch (e) {
              return null;
            }
          })(),
          styles: styles
        };
      }

      function hideOverlay() {
        if (box) box.style.display = 'none';
        if (tag) tag.style.display = 'none';
      }

      function draw(el) {
        if (!el || (el.hasAttribute && el.hasAttribute('data-dsh-pointer'))) { hideOverlay(); return; }
        ensureNodes();
        if (!box) return;
        var rect = el.getBoundingClientRect();
        box.style.display = 'block';
        box.style.left = rect.left + 'px';
        box.style.top = rect.top + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
        tag.style.display = 'block';
        tag.textContent = shortName(el) + '  ' + Math.round(rect.width) + ' × ' + Math.round(rect.height);
        tag.style.left = Math.max(2, Math.min(rect.left, window.innerWidth - 80)) + 'px';
        tag.style.top = Math.max(2, rect.top > 24 ? rect.top - 20 : rect.bottom + 4) + 'px';
      }

      var marks = [];

      function clearMarks() {
        for (var i = 0; i < marks.length; i += 1) {
          try { marks[i].el.remove(); } catch (e) {}
        }
        marks = [];
      }

      /** Recolour marks: the one matching the hovered composer chip turns amber. */
      function applyHover(id) {
        for (var i = 0; i < marks.length; i += 1) {
          var entry = marks[i];
          var active = id !== null && id !== '' && entry.id === id;
          try {
            entry.el.style.borderColor = active ? '#f59e0b' : entry.color;
            entry.el.style.boxShadow = active ? '0 0 0 3px rgba(245, 158, 11, 0.35)' : 'none';
            entry.badge.style.background = active ? '#f59e0b' : entry.color;
          } catch (e) {}
        }
      }

      function addMarks(list) {
        ensureNodes();
        if (!document.body) return;
        for (var m = 0; m < list.length; m += 1) {
          var mark = list[m] || {};
          try {
            var rect = null;
            if (mark.rect) {
              rect = { left: mark.rect.x + window.scrollX, top: mark.rect.y + window.scrollY, width: mark.rect.width, height: mark.rect.height };
            } else if (mark.selector) {
              var target = document.querySelector(mark.selector);
              if (target) {
                var r = target.getBoundingClientRect();
                rect = { left: r.left + window.scrollX, top: r.top + window.scrollY, width: r.width, height: r.height };
              }
            }
            if (!rect) continue;
            var isRegion = mark.variant === 'region';
            var color = mark.color || (isRegion ? '#3b82f6' : '#4f8ef7');
            var wrap = document.createElement('div');
            wrap.setAttribute('data-dsh-pointer', 'mark');
            wrap.style.cssText = 'position:absolute;z-index:2147483645;pointer-events:none;box-sizing:border-box;'
              + (isRegion
                ? 'border:2px dashed ' + color + ';background:rgba(59,130,246,0.10);border-radius:4px;'
                : 'border:2px solid ' + color + ';background:transparent;border-radius:2px;');
            wrap.style.left = rect.left + 'px';
            wrap.style.top = rect.top + 'px';
            wrap.style.width = rect.width + 'px';
            wrap.style.height = rect.height + 'px';
            var badge = document.createElement('div');
            badge.textContent = mark.id || '';
            badge.style.cssText = 'position:absolute;left:-2px;top:-18px;font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:0 5px;border-radius:3px;background:' + color + ';color:#fff;white-space:nowrap';
            wrap.appendChild(badge);
            document.body.appendChild(wrap);
            marks.push({ el: wrap, badge: badge, id: mark.id || '', color: color });
          } catch (e) {}
        }
      }

      function hitTest(area) {
        var out = [];
        var all = document.querySelectorAll('body *');
        var viewport = Math.max(1, window.innerWidth * window.innerHeight);
        for (var i = 0; i < all.length; i += 1) {
          var el = all[i];
          if (el.hasAttribute('data-dsh-pointer')) continue;
          if (el === document.documentElement || el === document.body) continue;
          var r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          if (r.right < area.left || r.left > area.right || r.bottom < area.top || r.top > area.bottom) continue;
          if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) continue;
          var elArea = r.width * r.height;
          // A marquee almost always intersects the page shell; reporting a
          // near-viewport element drowns the real targets, so skip those.
          if (elArea > viewport * 0.6) continue;
          out.push({ el: el, area: elArea });
        }
        // Leaf-most only: drop any hit that contains another hit, so a region
        // reports the items inside it instead of their ancestor chain.
        var els = out.map(function (entry) { return entry.el; });
        out = out.filter(function (entry) {
          for (var j = 0; j < els.length; j += 1) {
            if (els[j] !== entry.el && entry.el.contains(els[j])) return false;
          }
          return true;
        });
        out.sort(function (a, b) { return a.area - b.area; });
        return out.slice(0, 8).map(function (entry) { return summarize(entry.el); });
      }

      function swallow(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }

      function onMove(event) {
        if (state.mode !== 'pick') return;
        if (state.dragging) {
          ensureNodes();
          if (regionEl) {
            var x1 = Math.min(state.dragging.x, event.clientX);
            var y1 = Math.min(state.dragging.y, event.clientY);
            var x2 = Math.max(state.dragging.x, event.clientX);
            var y2 = Math.max(state.dragging.y, event.clientY);
            regionEl.style.display = 'block';
            regionEl.style.left = x1 + 'px';
            regionEl.style.top = y1 + 'px';
            regionEl.style.width = (x2 - x1) + 'px';
            regionEl.style.height = (y2 - y1) + 'px';
          }
          return;
        }
        var el = document.elementFromPoint(event.clientX, event.clientY);
        if (!el) { hideOverlay(); return; }
        state.target = el;
        draw(el);
      }

      function onClick(event) {
        if (state.mode !== 'pick') return;
        swallow(event);
        if (state.justDragged) { state.justDragged = false; return; }
        var el = state.target || event.target;
        if (!el || el.nodeType !== 1 || (el.hasAttribute && el.hasAttribute('data-dsh-pointer'))) return;
        // The document root is never a meaningful target: elementFromPoint lands
        // there on blank gutters, and picking it dumps the whole page.
        if (el === document.documentElement || el === document.body) return;
        post({ t: 'pick', mode: 'element', items: [summarize(el)] });
      }

      function onDown(event) {
        if (state.mode !== 'pick') return;
        if (event.button === 2 || (event.button === 0 && event.shiftKey)) {
          swallow(event);
          state.dragging = { x: event.clientX, y: event.clientY };
          ensureNodes();
        }
      }

      function onUp(event) {
        if (state.mode !== 'pick' || !state.dragging) return;
        swallow(event);
        var start = state.dragging;
        state.dragging = null;
        if (regionEl) regionEl.style.display = 'none';
        var left = Math.min(start.x, event.clientX);
        var top = Math.min(start.y, event.clientY);
        var width = Math.abs(event.clientX - start.x);
        var height = Math.abs(event.clientY - start.y);
        state.justDragged = true;
        if (width < 6 || height < 6) return;
        var items = hitTest({ left: left, top: top, right: left + width, bottom: top + height });
        post({
          t: 'pick', mode: 'region',
          region: { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) },
          items: items
        });
      }

      function onContext(event) {
        if (state.mode === 'pick') swallow(event);
      }

      function onMessage(event) {
        var data = event.data;
        if (!data || data.__dshPointer !== true) return;
        if (data.t === 'mark') { addMarks(data.marks || []); return; }
        if (data.t === 'clearmarks') { clearMarks(); return; }
        if (data.t === 'hover') { applyHover(data.id == null ? null : String(data.id)); return; }
        if (data.t === 'syncmarks') {
          clearMarks();
          addMarks(data.marks || []);
          applyHover(data.hover == null ? null : String(data.hover));
          return;
        }
        if (data.t === 'mode') {
          state.mode = data.mode === 'pick' ? 'pick' : 'off';
          if (state.mode === 'off') { hideOverlay(); state.dragging = null; state.justDragged = false; }
          ensureNodes();
        }
      }

      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('mousedown', onDown, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('contextmenu', onContext, true);
      window.addEventListener('message', onMessage, false);

      window[KEY] = {
        v: 1,
        mode: function () { return state.mode; },
        setMode: function (value) { state.mode = value === 'pick' ? 'pick' : 'off'; },
      };

      post({ t: 'ready', caps: { element: true, region: true, sourceMap: true } });
      setInterval(function () { post({ t: 'alive' }); }, 4000);
    }
    //#endregion

    const PROBE_SOURCE = '(' + probeInstall.toString() + ')();';

    //#region helpers
    /**
     * Relative assets are inlined as `data:` URLs, not blob URLs: the preview
     * runs in an opaque-origin sandbox, where a blob created by the host page is
     * cross-origin and would be refused. `data:` carries no origin.
     */
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
      pdf: 'application/pdf',
      txt: 'text/plain',
      csv: 'text/csv',
      html: 'text/html',
      htm: 'text/html',
    };

    /** Total inlined payload ceiling, so one huge asset cannot freeze the pane. */
    const INLINE_BUDGET_BYTES = 8 * 1024 * 1024;

    /**
     * Parse a `dsh-resource://file/…` address. DSH uses two scopes: `session`
     * (workspace-relative, carries the session id) and `absolute` (a host path
     * outside the workspace, no session id — the caller supplies the scope).
     */
    function parseSessionFileAddress(address) {
      const prefix = 'dsh-resource://file/';
      if (typeof address !== 'string' || address.indexOf(prefix) !== 0) return null;
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
            sessionId: decodeURIComponent(id),
            path: parts.map((segment) => decodeURIComponent(segment)).join('/'),
          };
        }
        if (scope === 'absolute') {
          const unc = parts[0] === '' && parts.length > 1;
          const segments = (unc ? parts.slice(1) : parts).map((segment) => decodeURIComponent(segment));
          if (segments.length === 0 || segments[0] === '') return null;
          if (unc) return { sessionId: null, path: '//' + segments.join('/') };
          const path = /^[A-Za-z]:$/.test(segments[0]) ? segments.join('/') : '/' + segments.join('/');
          return { sessionId: null, path };
        }
      } catch {
        return null;
      }
      return null;
    }

    function isRelativeRef(value) {
      const ref = String(value || '').trim();
      if (!ref) return false;
      if (ref.startsWith('#') || ref.startsWith('//')) return false;
      // Any scheme (http:, https:, data:, blob:, mailto:, javascript:…) is left alone.
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) return false;
      return true;
    }

    function extensionOf(ref) {
      const clean = String(ref).split('#')[0].split('?')[0];
      const match = clean.match(/\.([a-zA-Z0-9]{1,8})$/);
      return match ? match[1].toLowerCase() : '';
    }

    function bytesToBase64(bytes) {
      let binary = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      return btoa(binary);
    }

    function toBytes(data) {
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (Array.isArray(data)) return new Uint8Array(data);
      if (data && typeof data === 'object' && data.type === 'Buffer' && Array.isArray(data.data)) {
        return new Uint8Array(data.data);
      }
      return null;
    }

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /** Resolve `url(...)` references inside a stylesheet against that sheet's path. */
    async function inlineCssUrls(cssText, readBytes) {
      const urls = [...String(cssText).matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]);
      let out = String(cssText);
      for (const raw of new Set(urls)) {
        if (!isRelativeRef(raw)) continue;
        const mime = MIME_BY_EXT[extensionOf(raw)] || 'application/octet-stream';
        try {
          const result = await readBytes(raw);
          const bytes = toBytes(result && result.data);
          if (!bytes || bytes.length === 0) continue;
          out = out.split(raw).join('data:' + mime + ';base64,' + bytesToBase64(bytes));
        } catch {
          /* leave the reference untouched */
        }
      }
      return out;
    }

    /**
     * Inline every relative `src`/`href` the document references. Missing files
     * are left untouched so a single absent asset never blanks the preview.
     */
    async function inlineAssets(html, readBytes) {
      let out = String(html);
      const attrRe = /\b(src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
      const refs = new Map();
      for (const match of out.matchAll(attrRe)) {
        const raw = match[3] ?? match[4] ?? match[5] ?? '';
        if (!isRelativeRef(raw)) continue;
        const clean = raw.split('#')[0].split('?')[0];
        if (!clean || refs.has(raw)) continue;
        refs.set(raw, clean);
      }
      let spent = 0;
      let inlined = 0;
      const failures = [];
      for (const [raw, clean] of refs) {
        const mime = MIME_BY_EXT[extensionOf(clean)] || 'application/octet-stream';
        try {
          const result = await readBytes(clean, null);
          const bytes = toBytes(result && result.data);
          if (!bytes || bytes.length === 0) continue;
          if (spent + bytes.length > INLINE_BUDGET_BYTES) continue;
          spent += bytes.length;
          inlined += 1;
          if (mime === 'text/css') {
            const cssPath = (result && result.absolutePath) || null;
            const css = await inlineCssUrls(
              new TextDecoder('utf-8').decode(bytes),
              (rel) => readBytes(rel, cssPath),
            );
            const linkRe = new RegExp('<link[^>]*href\\s*=\\s*["\']' + escapeRegExp(raw) + '["\'][^>]*>', 'i');
            out = out.replace(linkRe, () => '<style>' + css.replace(/<\/style/gi, '<\\/style') + '</style>');
          } else {
            out = out.split(raw).join('data:' + mime + ';base64,' + bytesToBase64(bytes));
          }
        } catch (error) {
          failures.push(clean + ': ' + String(error && error.message ? error.message : error).slice(0, 100));
        }
      }
      return { html: out, attempted: refs.size, inlined, bytes: spent, failures };
    }

    /** The session workspace root; session-scoped addresses resolve against it. */
    function sessionWorkspaceCwd(ctx, sessionId) {
      try {
        const list = ctx && ctx.sessions ? ctx.sessions.list : null;
        const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null;
        const byId = snapshot && snapshot.byId ? snapshot.byId : null;
        const entry = byId && sessionId ? byId[sessionId] : null;
        return (entry && entry.cwd) || null;
      } catch {
        return null;
      }
    }

    /** Read one workspace file relative to the previewed document. */
    async function readAssetBytes(ctx, sessionId, relativePath, basePath) {
      try {
        const remote = ctx && ctx.remote && ctx.remote.workspaceFiles;
        if (!remote || !sessionId) return null;
        const result = await remote.readBytes(
          sessionId,
          relativePath,
          basePath ? { baseFile: basePath } : {},
          undefined,
        );
        if (!result || result.ok !== true) return null;
        return result.value || null;
      } catch {
        return null;
      }
    }

    function decodeContent(content) {
      if (!content || typeof content !== 'object') return '';
      if (content.kind === 'text') return String(content.text || '');
      if (content.kind === 'bytes') {
        const data = content.data;
        if (typeof data === 'string') return data;
        try {
          return new TextDecoder('utf-8').decode(data);
        } catch {
          return '';
        }
      }
      return '';
    }

    function stripBlockingCsp(text) {
      return text.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
    }

    function buildDocument(text) {
      const cleaned = stripBlockingCsp(String(text || ''));
      const script = '<script>' + PROBE_SOURCE + '</scr' + 'ipt>';
      if (/<\/body\s*>/i.test(cleaned)) return cleaned.replace(/<\/body\s*>/i, script + '</body>');
      if (/<\/html\s*>/i.test(cleaned)) return cleaned.replace(/<\/html\s*>/i, script + '</html>');
      return cleaned + script;
    }

    function offsetToLineColumn(source, index) {
      let line = 1;
      let lineStart = 0;
      for (let i = 0; i < index; i += 1) {
        if (source.charCodeAt(i) === 10) {
          line += 1;
          lineStart = i + 1;
        }
      }
      return { line, column: index - lineStart + 1 };
    }

    /**
     * Map a picked element back to source. Identical markup occurs many times in
     * real documents, so the probe reports this element's ordinal among elements
     * with the *same* outerHTML and we take the matching occurrence.
     */
    /** Undo inlining on a rendered subtree so it can be matched against the file. */
    function restoreInlinedRefs(outerHTML, pairs) {
      if (!Array.isArray(pairs) || pairs.length === 0) return outerHTML;
      let out = String(outerHTML);
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        if (out.indexOf(pair[1]) >= 0) out = out.split(pair[1]).join(pair[0]);
      }
      return out;
    }

    function locateInSource(source, outerHTML, ordinal) {
      if (!source || !outerHTML || outerHTML.length < 8) return null;
      const positions = [];
      let from = 0;
      while (positions.length < 128) {
        const at = source.indexOf(outerHTML, from);
        if (at < 0) break;
        positions.push(at);
        from = at + 1;
      }
      if (positions.length === 0) return null;
      let chosen = positions[0];
      if (ordinal && typeof ordinal.index === 'number' && ordinal.index >= 0 && ordinal.index < positions.length) {
        chosen = positions[ordinal.index];
      }
      return offsetToLineColumn(source, chosen);
    }

    /** contentId arrives percent-encoded (gpt%E7%94%9F…); show a readable path. */
    function humanPath(value) {
      if (!value) return '';
      const text = String(value);
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
      }
    }

    function shortPath(file) {
      const full = humanPath(file);
      if (!full) return '';
      const parts = full.split(/[\\/]/);
      return parts.length <= 2 ? full : '…/' + parts.slice(-2).join('/');
    }

    function renderModelText(items, mode, label, file) {
      const lines = [
        label + '（在 DSH 预览中由「指代器」选中，页面: ' + shortPath(file) + '）',
      ];
      items.forEach((item, index) => {
        const loc = item.loc && item.loc.line ? '  第 ' + item.loc.line + ' 行' + (item.loc.column ? ':' + item.loc.column : '') : '';
        lines.push((items.length > 1 ? index + 1 + '. ' : '') + '选择器: ' + (item.selector || '(未知)') + loc);
        const attrs = [
          item.id ? 'id="' + item.id + '"' : '',
          item.classes && item.classes.length ? 'class="' + item.classes.join(' ') + '"' : '',
        ].filter(Boolean).join(' ');
        lines.push('  标签: <' + (item.tag || '?') + (attrs ? ' ' + attrs : '') + '>');
        if (item.text) lines.push('  文本: ' + JSON.stringify(String(item.text).slice(0, 200)));
        if (item.outerHTML) lines.push('  outerHTML: ' + String(item.outerHTML).slice(0, 1500));
      });
      return lines.join('\n');
    }

    /** Compact marker shown in the transcript after send; full data travels via the context block. */
    function renderBrief(items, mode, label) {
      const first = items[0] || {};
      const tag = first.tag ? '<' + first.tag + '>' : '';
      const line = first.loc && first.loc.line ? ' · 第 ' + first.loc.line + ' 行' : '';
      const more = items.length > 1 ? ' +' + (items.length - 1) : '';
      return '[' + label + (tag ? ' · ' + tag : '') + line + more + ']';
    }

    function createStore() {
      const byRef = new Map();
      const markMap = new Map();
      const listeners = new Set();
      let seq = 0;
      const notify = () => {
        for (const listener of listeners) {
          try { listener(); } catch { /* ignore */ }
        }
      };
      return {
        remember(items, mode, file) {
          seq += 1;
          const ref = 'pointer-' + seq;
          const label = (mode === 'region' ? '区域' : '元素') + seq;
          byRef.set(ref, {
            label,
            text: renderModelText(items, mode, label, file),
            brief: renderBrief(items, mode, label),
          });
          notify();
          return { ref, label };
        },
        labelOf(ref) {
          const entry = byRef.get(ref);
          return entry ? entry.label : '元素';
        },
        textOf(ref) {
          const entry = byRef.get(ref);
          return entry ? entry.text : '';
        },
        briefOf(ref) {
          const entry = byRef.get(ref);
          return entry ? entry.brief : '元素';
        },
        rememberMark(label, info) {
          if (label) markMap.set(label, info);
        },
        marksForLabels(labels) {
          const out = [];
          for (const label of labels) {
            const info = markMap.get(label);
            if (info) out.push({ id: label, variant: info.variant, color: info.color, selector: info.selector, rect: info.rect });
          }
          return out;
        },
        /** Tooltip text for a rendered sentinel chip, keyed by its visible label. */
        tooltipOfLabel(label) {
          for (const entry of byRef.values()) {
            if (entry.label === label) return entry.text.slice(0, 400);
          }
          return label;
        },
        entries() {
          return [...byRef.entries()];
        },
        reset() {
          byRef.clear();
          seq = 0;
          notify();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    function createTriggerSource(store) {
      return {
        trigger: TRIGGER,
        name: SOURCE_NAME,
        order: 91,
        candidates: async () => store.entries().map(([ref, entry]) => ({
          name: entry.label,
          description: '指代器在预览中选中的元素',
          value: ref,
        })),
        onPick: (pick) => {
          const ref = pick && pick.candidate ? pick.candidate.value : undefined;
          if (!ref) return undefined;
          const entry = store.entries().find(([key]) => key === ref);
          if (!entry) return undefined;
          return {
            insert: {
              source: SOURCE_NAME,
              ref,
              label: entry[1].label,
              clipboardText: entry[1].label,
              appearance: 'session',
            },
          };
        },
        lexicon: () => store.entries().map(([, entry]) => entry.label),
        subscribeLexicon: (_session, listener) => store.subscribe(listener),
        codec: {
          clipboardText: (ref) => store.labelOf(ref),
          serialize: async (ref) => '⟦' + store.labelOf(ref) + '⟧',
        },
      };
    }

    /**
     * Sentinels (⟦元素1⟧) are what the model and the stored message see; this
     * decorator swaps them for a chip in the transcript only, so the user reads
     * a compact reference while the message content stays plain text.
     * Failure mode is graceful: an undecorated sentinel is still readable.
     */
    const SENTINEL_RE = /⟦([^⟧\n]{1,40})⟧/g;

    let chipTemplate = null;

    /** Clone a real composer chip so the transcript chip is visually identical. */
    function captureChipTemplate() {
      if (chipTemplate) return;
      try {
        const el = document.querySelector('[data-composer-chip="' + SOURCE_NAME + '"]');
        if (el && el.childElementCount > 0) chipTemplate = el.cloneNode(true);
      } catch { /* fall back to the self-drawn chip */ }
    }

    function buildSentinelChip(label, tooltip) {
      if (chipTemplate) {
        const clone = chipTemplate.cloneNode(true);
        // Never let a decorated transcript node look like a composer chip:
        // hover detection and mark reconciliation query that attribute.
        clone.removeAttribute('data-composer-chip');
        clone.removeAttribute('contenteditable');
        clone.setAttribute('data-dsh-pointer-chip', label);
        clone.setAttribute('title', tooltip || label);
        const labelEl = clone.querySelector('[class*="label"]') || clone.lastElementChild;
        if (labelEl) labelEl.textContent = label;
        else clone.textContent = label;
        return clone;
      }
      const chip = document.createElement('span');
      chip.setAttribute('data-dsh-pointer-chip', label);
      chip.setAttribute('title', tooltip || label);
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:1px 7px;margin:0 2px;'
        + 'border-radius:5px;background:rgba(79,142,247,.14);color:#2f6fed;font-weight:500;'
        + 'white-space:nowrap;vertical-align:baseline;cursor:default';
      const dot = document.createElement('span');
      dot.textContent = '\u25C9';
      dot.style.cssText = 'font-size:10px;opacity:.85;line-height:1';
      chip.append(dot, document.createTextNode(label));
      return chip;
    }

    function decorateSentinels(root, lookup) {
      const stats = { scanned: 0, matched: 0, decorated: 0 };
      if (!root || root.nodeType !== 1) return stats;
      if (root.closest('[data-dsh-pointer-chip]')) return stats;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || node.nodeValue.indexOf('⟦') < 0) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest('[data-dsh-pointer-chip]')) return NodeFilter.FILTER_REJECT;
          if (parent.closest('script,style,textarea,input')) return NodeFilter.FILTER_REJECT;
          if (parent.closest('[contenteditable="true"],[contenteditable=""]')) return NodeFilter.FILTER_REJECT;
          stats.scanned += 1;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const targets = [];
      while (walker.nextNode()) targets.push(walker.currentNode);
      for (const node of targets) {
        const text = node.nodeValue;
        SENTINEL_RE.lastIndex = 0;
        if (!SENTINEL_RE.test(text)) continue;
        SENTINEL_RE.lastIndex = 0;
        stats.matched += 1;
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        let match;
        while ((match = SENTINEL_RE.exec(text)) !== null) {
          if (match.index > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.index)));
          fragment.append(buildSentinelChip(match[1], lookup(match[1])));
          cursor = match.index + match[0].length;
        }
        if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
        const parent = node.parentNode;
        if (parent) {
          parent.replaceChild(fragment, node);
          stats.decorated += 1;
        }
      }
      return stats;
    }

    let sentinelKick = () => {};

    function reportDebug(payload) {
      try {
        void fetch(PICK_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ debug: payload }),
        });
      } catch { /* diagnostics must never break anything */ }
    }

    function installSentinelDecorator(store) {
      const lookup = (label) => store.tooltipOfLabel(label);
      const pending = new Set();
      let scheduled = false;
      let lastReport = 0;
      let totalDecorated = 0;

      const sweep = (root) => {
        let stats = { scanned: 0, matched: 0, decorated: 0 };
        try {
          stats = decorateSentinels(root, lookup) || stats;
        } catch { /* never break the transcript for decoration */ }
        if (stats.decorated > 0) totalDecorated += stats.decorated;
        return stats;
      };

      const flush = () => {
        scheduled = false;
        const roots = [...pending];
        pending.clear();
        let scanned = 0;
        let matched = 0;
        let decorated = 0;
        for (const root of roots) {
          const stats = sweep(root);
          scanned += stats.scanned;
          matched += stats.matched;
          decorated += stats.decorated;
        }
        const now = Date.now();
        if (now - lastReport > 1500 && (scanned > 0 || matched > 0 || decorated > 0)) {
          lastReport = now;
          const bodyText = document.body ? document.body.innerText || '' : '';
          const at = bodyText.indexOf('⟦');
          reportDebug({
            event: 'decorate-flush',
            scanned,
            matched,
            decorated,
            totalDecorated,
            bodyHasSentinel: at >= 0,
            sample: at >= 0 ? bodyText.slice(Math.max(0, at - 30), at + 40) : '',
            chips: document.querySelectorAll('[data-dsh-pointer-chip]').length,
          });
        }
      };

      const schedule = (root) => {
        if (!root || root.nodeType !== 1) return;
        pending.add(root);
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(flush);
      };

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'characterData') {
            if (record.target && record.target.parentElement) schedule(record.target.parentElement);
            continue;
          }
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) schedule(node);
            else if (node.nodeType === 3 && node.parentElement) schedule(node.parentElement);
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

      const initial = sweep(document.documentElement);
      reportDebug({
        event: 'decorate-install',
        scanned: initial.scanned,
        matched: initial.matched,
        decorated: initial.decorated,
        rows: document.body ? document.body.childElementCount : -1,
      });

      // After a pick the message only renders on send, so sweep for a while.
      let sweeps = 0;
      sentinelKick = () => {
        sweeps = 0;
        const timer = setInterval(() => {
          sweeps += 1;
          const stats = sweep(document.documentElement);
          if (stats.decorated > 0 || sweeps > 24) clearInterval(timer);
        }, 800);
      };

      return () => {
        observer.disconnect();
        sentinelKick = () => {};
      };
    }

    function insertChip(ctx, store, sessionId, items, mode, file) {
      if (!sessionId) throw new Error('no session bound to this preview');
      const binding = ctx.sessions.binding(sessionId);
      if (!binding) throw new Error('session binding unavailable');
      const input = ctx.conversation.input.for(binding.ctx);
      const state = input.state.getSnapshot();
      const { ref, label } = store.remember(items, mode, file);
      const chipExtra = state.occurrences.reduce((sum, occ) => sum + (occ.length - 1), 0);
      const at = Math.max(0, state.draft.length - chipExtra);
      const applied = input.insertReference(
        { source: SOURCE_NAME, ref, label, clipboardText: label, appearance: 'session' },
        { start: at, end: at, draftRev: state.draftRev },
      );
      if (!applied) throw new Error('composer refused the reference insert');
      return label;
    }
    //#endregion

    //#region preview body
    /**
     * The 指代器 toggle lives in the document header
     * (`sidebar.right.tab.document.actions`), which is rendered outside our pane
     * component. A tiny registry bridges the two: only the visible pane answers.
     */
    const previewRegistry = new Set();
    const previewListeners = new Set();

    function notifyPreviews() {
      for (const listener of previewListeners) {
        try { listener(); } catch { /* subscriber failure must not break the UI */ }
      }
    }

    function visiblePreview() {
      for (const entry of previewRegistry) {
        try {
          if (entry.visible()) return entry;
        } catch { /* ignore */ }
      }
      return null;
    }

    /** Pane content shown when the document exceeds the configured guard. */
    function buildTooLargePage(stats) {
      const size = stats && stats.size ? (stats.size / 1024 / 1024).toFixed(1) : '?';
      const limit = stats && stats.limit ? Math.round(stats.limit / 1024 / 1024) : '?';
      return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>文件过大</title></head>'
        + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
        + 'font:14px/1.75 system-ui,-apple-system,sans-serif;background:#fafafa;color:#333">'
        + '<div style="max-width:470px;padding:26px 30px;border:1px solid #e5e7eb;border-radius:12px;'
        + 'background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.06)">'
        + '<h2 style="margin:0 0 10px;font-size:16px;font-weight:600">文件过大，未加载预览</h2>'
        + '<p style="margin:0 0 12px;color:#555">该文件 <b>' + size + ' MB</b>，超过当前预览上限 <b>' + limit + ' MB</b>。</p>'
        + '<p style="margin:0;color:#777;font-size:13px">在预览头部的「▾」菜单里把「大文件上限」调大，'
        + '或设为「不限」即可打开。指代器在该文件上暂不可用。</p>'
        + '</div></body></html>';
    }

    function DocPointerAction() {
      const [, bump] = React.useState(0);
      const [settings, setSettings] = React.useState({ maxFileMb: 100 });
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null);
      React.useEffect(() => {
        if (!open) return undefined;
        let live = true;
        void (async () => {
          try {
            const response = await fetch(SETTINGS_ROUTE, { method: 'GET' });
            const body = await response.json();
            if (live && body && body.ok && body.settings) setSettings(body.settings);
          } catch { /* keep the current value */ }
        })();
        return () => { live = false; };
      }, [open]);
      React.useEffect(() => {
        const listener = () => bump((n) => n + 1);
        previewListeners.add(listener);
        return () => previewListeners.delete(listener);
      }, []);
      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown, true);
        return () => document.removeEventListener('mousedown', onDown, true);
      }, [open]);

      const entry = visiblePreview();
      if (!entry) return null;
      const state = entry.state();
      const active = state.active === true;
      const ready = state.status === 'ready';
      const accent = 'var(--dsw-alias-state-business-primary, #2f6fed)';
      const border = '1px solid ' + (active ? accent : 'var(--dsw-alias-border-l3, #d9d9d9)');
      const base = {
        display: 'inline-flex', alignItems: 'center', gap: 4,
        height: 24, padding: '0 8px', fontSize: 12, lineHeight: '22px',
        fontFamily: 'inherit', whiteSpace: 'nowrap', cursor: 'pointer',
        background: active ? 'color-mix(in srgb, ' + accent + ' 12%, transparent)' : 'transparent',
        color: active ? accent : 'inherit',
      };

      const menu = open
        ? h('div', {
          style: {
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60,
            minWidth: 208, padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
            fontSize: 12, lineHeight: 1.5, textAlign: 'left',
            borderRadius: 8, border: '1px solid var(--dsw-alias-border-l3, #d9d9d9)',
            background: 'var(--dsw-alias-bg-layer-2, #fff)',
            boxShadow: '0 8px 28px rgba(0,0,0,.16)',
            color: 'var(--dsw-alias-label-primary, inherit)',
          },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('span', { style: { opacity: 0.75 } }, '探针状态'),
          h('span', { style: { color: ready ? '#16a34a' : '#b45309' } },
            (ready ? '\u25CF ' : '\u25CB ') + (ready ? '已就绪' : '未连接'))),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('span', { style: { opacity: 0.75 } }, '本次已选'),
          h('span', null, String(state.count || 0))),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('span', { style: { opacity: 0.75 } }, '大文件上限'),
          h('select', {
            value: String(settings.maxFileMb),
            onChange: (event) => {
              const value = Number(event.target.value);
              setSettings({ maxFileMb: value });
              void (async () => {
                try {
                  const response = await fetch(SETTINGS_ROUTE, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ maxFileMb: value }),
                  });
                  const body = await response.json();
                  if (body && body.ok && body.settings) setSettings(body.settings);
                } catch { /* keep the optimistic value */ }
              })();
            },
            style: {
              font: 'inherit', padding: '1px 4px', borderRadius: 4,
              border: '1px solid var(--dsw-alias-border-l3, #d9d9d9)',
              background: 'var(--dsw-alias-bg-layer-2, #fff)', color: 'inherit',
            },
          },
          [50, 100, 200, 500, 0].map((mb) => h('option', { key: mb, value: String(mb) },
            mb === 0 ? '不限' : mb + ' MB')))),
        h('div', { style: { opacity: 0.75, borderTop: '1px solid var(--dsw-alias-border-l2, #eee)', paddingTop: 8 } },
          '左键选中元素 · 右键拖拽框选区域'),
        h('button', {
          type: 'button',
          disabled: !(state.count > 0),
          onClick: () => { try { entry.clear(); } catch { /* ignore */ } setOpen(false); },
          style: {
            ...base, height: 26, justifyContent: 'center', whiteSpace: 'nowrap',
            borderRadius: 6, border: '1px solid var(--dsw-alias-border-l3, #d9d9d9)',
            background: 'transparent', color: 'inherit',
            opacity: state.count > 0 ? 1 : 0.45, cursor: state.count > 0 ? 'pointer' : 'default',
          },
        }, '清除全部标记'))
        : null;

      return h('span', {
        ref: rootRef,
        style: { position: 'relative', display: 'inline-flex', alignItems: 'center', flex: 'none', whiteSpace: 'nowrap', margin: '0 2px' },
      },
      h('button', {
        type: 'button',
        title: '指代器：左键选中元素，右键拖拽框选区域',
        onClick: () => entry.setActive(!active),
        style: { ...base, border, borderRadius: '6px 0 0 6px', borderRight: 'none' },
      },
      h('span', { style: { fontSize: 9, opacity: ready ? 1 : 0.45 } }, ready ? '\u25C9' : '\u25CB'),
      active ? '指代中…' : '指代器'),
      h('button', {
        type: 'button',
        title: '状态与选项',
        onClick: () => setOpen((value) => !value),
        style: { ...base, padding: '0 6px', border, borderRadius: '0 6px 6px 0', opacity: 0.85 },
      }, '\u25BE'),
      menu);
    }

    function createPointerPreview(store) {
      return function PointerPreview(props) {
        const [active, setActive] = React.useState(false);
        const [status, setStatus] = React.useState('wait');
        const [count, setCount] = React.useState(0);
        const [notice, setNotice] = React.useState('');
        const frameRef = React.useRef(null);
        const lastAliveRef = React.useRef(0);
        const noticeTimer = React.useRef(0);

        // The "large file" renderer mounts before any bytes are read, so its
        // content carries only the load lifecycle. Everything is fetched from
        // the host route instead, which reads with plain fs (no 32 MB cap).
        const rendererMode = Boolean(props.content && props.content.kind === 'renderer');
        const contentRevision =
          props.content && typeof props.content.revision === 'number' ? props.content.revision : 0;
        const sourceText = React.useMemo(
          () => (rendererMode ? '' : decodeContent(props.content)),
          [props.content, rendererMode],
        );
        const sourceRef = React.useRef(sourceText);
        if (!rendererMode) sourceRef.current = sourceText;
        const fileInfo = React.useMemo(
          () => parseSessionFileAddress(props.resourceAddress || ''),
          [props.resourceAddress],
        );
        const inlinePairsRef = React.useRef([]);
        const replaceNextRef = React.useRef(false);
        const [doc, setDoc] = React.useState(() => buildDocument(sourceText));
        React.useEffect(() => {
          let live = true;
          setDoc(rendererMode ? buildDocument('') : buildDocument(sourceText));
          void (async () => {
            const address = props.resourceAddress || '';
            const cwdSessionId = (fileInfo && fileInfo.sessionId) || props.sessionId || null;
            const cwd = sessionWorkspaceCwd(props.ctx, cwdSessionId);
            // Primary: host-side inlining. The host has plain filesystem access,
            // so this needs neither the remote service nor a session scope.
            try {
              const response = await fetch('/dsh-pointer/inline', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  address,
                  cwd,
                  path: fileRef.current || '',
                  includeSource: true,
                }),
              });
              const body = await response.json();
              reportDebug({
                event: 'inline-host',
                rendererMode,
                status: response.status,
                cwd,
                ok: Boolean(body && body.ok),
                stats: (body && body.stats) || null,
                error: (body && body.error) || null,
              });
              if (live && body && body.ok === false && body.error === 'file-too-large') {
                setDoc(buildTooLargePage(body.stats));
                if (rendererMode && props.content && typeof props.content.loaded === 'function') {
                  try { props.content.loaded(undefined); } catch { /* lifecycle contract guarded */ }
                }
                return;
              }
              if (live && body && body.ok && typeof body.html === 'string' && body.html.length > 0) {
                if (typeof body.source === 'string') sourceRef.current = body.source;
                if (Array.isArray(body.pairs)) inlinePairsRef.current = body.pairs;
                setDoc(buildDocument(body.html));
                if (rendererMode && props.content && typeof props.content.loaded === 'function') {
                  try { props.content.loaded(undefined); } catch { /* lifecycle contract guarded */ }
                }
                return;
              }
            } catch (error) {
              reportDebug({ event: 'inline-host-error', message: String(error && error.message ? error.message : error) });
            }
            if (rendererMode) {
              if (props.content && typeof props.content.failed === 'function') {
                try { props.content.failed(); } catch { /* lifecycle contract guarded */ }
              }
              return;
            }
            // Fallback: client-side workspace read, only when a session scope is known.
            const sessionId = (fileInfo && fileInfo.sessionId) || props.sessionId;
            if (!sessionId) return;
            try {
              const documentPath = (fileInfo && fileInfo.path) || null;
              const result = await inlineAssets(
                sourceText,
                (rel, base) => readAssetBytes(props.ctx, sessionId, rel, base || documentPath),
              );
              if (live && result.html !== sourceText) setDoc(buildDocument(result.html));
            } catch {
              /* keep the un-inlined document */
            }
          })();
          return () => { live = false; };
        }, [sourceText, fileInfo, props.ctx, props.sessionId, props.resourceAddress, contentRevision, rendererMode]);

        let file = '';
        try {
          const info = props.useTabInfo ? props.useTabInfo() : null;
          file = (info && info.tab && (info.tab.path || info.tab.contentId)) || '';
        } catch {
          file = '';
        }
        if (!file || file.indexOf('dsh-resource://') === 0) {
          const parsed = parseSessionFileAddress(file || props.resourceAddress || '');
          file = (parsed && parsed.path) || file || props.resourceAddress || '';
        }
        const fileRef = React.useRef(file);
        fileRef.current = file;

        const flash = (text) => {
          setNotice(text);
          window.clearTimeout(noticeTimer.current);
          noticeTimer.current = window.setTimeout(() => setNotice(''), 4000);
        };

        /** Authoritative mark list = marks whose chip is currently in the composer. */
        React.useEffect(() => {
          const timer = window.setInterval(() => {
            if (lastAliveRef.current === 0) return;
            if (Date.now() - lastAliveRef.current > 9000) setStatus('wait');
          }, 3000);
          return () => window.clearInterval(timer);
        }, []);

        const syncMarks = React.useCallback((explicitLabels) => {
          const frame = frameRef.current;
          if (!frame || !frame.contentWindow) return;
          const labels = new Set();
          try {
            for (const el of document.querySelectorAll('[data-composer-chip="' + SOURCE_NAME + '"]')) {
              const text = String(el.textContent || '').trim();
              if (text) labels.add(text);
            }
          } catch { /* keep whatever we already have */ }
          for (const extra of explicitLabels || []) {
            if (extra) labels.add(extra);
          }
          frame.contentWindow.postMessage({
            __dshPointer: true,
            t: 'syncmarks',
            marks: store.marksForLabels([...labels]),
          }, '*');
        }, [store]);

        /** Drop preview marks + numbering only. The host context survives a send. */
        const clearLocalMarks = React.useCallback(() => {
          store.reset();
          // The pane counter mirrors the marks: clearing one must clear the other,
          // otherwise "已选 N" keeps claiming selections that no longer exist.
          setCount(0);
          const frame = frameRef.current;
          if (frame && frame.contentWindow) {
            frame.contentWindow.postMessage({ __dshPointer: true, t: 'clearmarks' }, '*');
          }
        }, [store]);

        /** Explicit "clear all": marks *and* the host-side context block. */
        const clearSelection = React.useCallback(() => {
          clearLocalMarks();
          replaceNextRef.current = false;
          try { void fetch(PICK_ROUTE, { method: 'DELETE' }); } catch { /* ignore */ }
        }, [clearLocalMarks]);

        const deliver = React.useCallback(async (items, mode, region) => {
          const enriched = items.map((item) => {
            // The rendered subtree carries inlined data: URLs; restore the
            // original relative refs so both the source lookup and the agent
            // context stay compact and readable.
            const outerHTML = restoreInlinedRefs(item.outerHTML, inlinePairsRef.current);
            const text = restoreInlinedRefs(item.text, inlinePairsRef.current);
            const loc = locateInSource(sourceRef.current, outerHTML, item.ordinal);
            const next = { ...item, outerHTML, text };
            return loc ? { ...next, loc: { file: fileRef.current, line: loc.line, column: loc.column } } : next;
          });

          // 1) Inline reference chip first: it is the fast, visible path. The
          //    label must exist before the payload is built because it names the
          //    target inside the context block.
          let label = '';
          try {
            label = insertChip(props.ctx, store, props.sessionId, enriched, mode, fileRef.current);
          } catch {
            label = '';
          }
          if (label) captureChipTemplate();

          // 2) Persistent numbered marks inside the preview.
          if (mode === 'region') {
            store.rememberMark(label || '区域', { variant: 'region', color: '#3b82f6', rect: region || null });
          } else {
            enriched.forEach((item, index) => {
              const markId = (label || '元素') + (enriched.length > 1 ? '.' + (index + 1) : '');
              store.rememberMark(markId, { variant: 'element', color: '#4f8ef7', selector: item.selector });
            });
          }
          syncMarks([label]);
          window.setTimeout(() => { try { syncMarks(); } catch { /* ignore */ } }, 180);
          window.setTimeout(() => { try { syncMarks(); } catch { /* ignore */ } }, 600);
          sentinelKick();

          setCount((n) => n + 1);
          flash(label ? label + ' 已插入输入框，可在句子里引用' : '已作为上下文附上（下一轮提示词生效）');

          // 3) Full payload lands in the host context block (fallback channel).
          //    Fire-and-forget: the chip is already visible, so a slow route must
          //    not delay the interaction. The payload is trimmed so a many-element
          //    region cannot exceed the host request-body limit.
          const replace = replaceNextRef.current === true;
          replaceNextRef.current = false;
          const payload = {
            replace,
            items: enriched.slice(0, mode === 'region' ? 16 : 8).map((item) => ({
              mode,
              label: label || '',
              file: fileRef.current,
              selector: item.selector,
              tag: item.tag,
              text: String(item.text || '').slice(0, mode === 'region' ? 240 : 500),
              outerHTML: String(item.outerHTML || '').slice(0, mode === 'region' ? 2048 : 8192),
              loc: item.loc || null,
            })),
          };
          void (async () => {
            try {
              const response = await fetch(PICK_ROUTE, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
              });
              reportDebug({
                event: 'pick-post',
                status: response.status,
                count: payload.items.length,
                label,
              });
            } catch (error) {
              reportDebug({
                event: 'pick-post-error',
                message: String(error && error.message ? error.message : error),
              });
            }
          })();
        }, [props.ctx, props.sessionId, store]);

        React.useEffect(() => {
          const onMessage = (event) => {
            const frame = frameRef.current;
            if (!frame || event.source !== frame.contentWindow) return;
            const data = event.data;
            if (!data || typeof data !== 'object' || data.v !== 1) return;
            if (data.t === 'ready' || data.t === 'alive') {
              lastAliveRef.current = Date.now();
              setStatus('ready');
              if (data.t === 'ready') syncMarks();
              return;
            }
            if (data.t === 'pick') {
              const items = Array.isArray(data.items) ? data.items : [];
              if (items.length === 0) return;
              void deliver(items, data.mode === 'region' ? 'region' : 'element', data.region || null);
            }
          };
          window.addEventListener('message', onMessage);
          return () => window.removeEventListener('message', onMessage);
        }, [deliver]);

        // Composer chips carry `data-composer-chip="<source>"` on their host span
        // (DSH ReferenceChipNode.createDOM), so our own chips are addressable
        // without touching the chip implementation. Hovering one recolours the
        // matching mark inside the preview.
        React.useEffect(() => {
          let hovered = null;
          const post = (id) => {
            if (id === hovered) return;
            hovered = id;
            const frame = frameRef.current;
            if (!frame || !frame.contentWindow) return;
            if (!frame.getClientRects().length) return;
            frame.contentWindow.postMessage({ __dshPointer: true, t: 'hover', id: id }, '*');
          };
          const onOver = (event) => {
            const target = event.target;
            if (!target || typeof target.closest !== 'function') return;
            const chip = target.closest('[data-composer-chip="' + SOURCE_NAME + '"]');
            if (chip) captureChipTemplate();
            post(chip ? String(chip.textContent || '').trim() : null);
          };
          const onOut = () => post(null);
          document.addEventListener('mouseover', onOver, true);
          document.addEventListener('mouseout', onOut, true);
          return () => {
            document.removeEventListener('mouseover', onOver, true);
            document.removeEventListener('mouseout', onOut, true);
          };
        }, []);

        React.useEffect(() => {
          const frame = frameRef.current;
          if (!frame || !frame.contentWindow) return;
          frame.contentWindow.postMessage({ __dshPointer: true, t: 'mode', mode: active ? 'pick' : 'off' }, '*');
        }, [active, status]);

        // Counter hygiene: once the composer empties (sent or cleared), the next
        // pick starts again at 元素1 instead of climbing forever.
        React.useEffect(() => {
          const ctx = props.ctx;
          const sessionId = props.sessionId;
          if (!ctx || !sessionId) return undefined;
          let binding;
          try {
            binding = ctx.sessions.binding(sessionId);
          } catch {
            return undefined;
          }
          if (!binding) return undefined;
          const input = ctx.conversation.input.for(binding.ctx);
          if (!input || !input.state) return undefined;
          let hadContent = input.state.getSnapshot().draft !== '';
          // Fresh preview file: nothing pending in the composer => restart at 元素1.
          if (!hadContent) clearSelection();
          const unsubscribe = input.state.subscribe(() => {
            const hasContent = input.state.getSnapshot().draft !== '';
            if (hadContent && !hasContent) {
              // Sending empties the composer, but the agent may still be about to
              // read the context block: keep it, and start the next pick fresh.
              clearLocalMarks();
              replaceNextRef.current = true;
            } else {
              syncMarks();
            }
            hadContent = hasContent;
          });
          return unsubscribe;
        }, [props.ctx, props.sessionId, store, clearSelection, clearLocalMarks, syncMarks]);

        const stateRef = React.useRef({ active: false, status: 'wait', count: 0 });
        stateRef.current = { active, status, count };
        React.useEffect(() => {
          const entry = {
            visible: () => {
              const frame = frameRef.current;
              return Boolean(frame && frame.getClientRects().length > 0);
            },
            state: () => stateRef.current,
            setActive: (value) => setActive(Boolean(value)),
            clear: () => clearSelection(),
          };
          previewRegistry.add(entry);
          notifyPreviews();
          return () => {
            previewRegistry.delete(entry);
            notifyPreviews();
          };
        }, []);
        React.useEffect(() => { notifyPreviews(); }, [active, status, count]);

        const bar = h('div', {
          style: {
            position: 'absolute', top: 8, right: 8, zIndex: 30,
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '4px 8px', borderRadius: 8,
            background: 'color-mix(in srgb, currentColor 6%, var(--dsw-alias-bg-base, #fff))',
            border: '1px solid var(--dsw-alias-border-l3, #ddd)',
            font: '12px/1.4 system-ui, sans-serif',
          },
        },
        count > 0 ? h('span', { style: { opacity: 0.7 } }, '已选 ' + count) : null,
        notice ? h('span', { style: { maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 } }, notice) : null);

        const barVisible = count > 0 || Boolean(notice);
        return h('div', { style: { position: 'relative', width: '100%', height: '100%', minHeight: 240, background: 'var(--dsw-alias-bg-base, #fff)' } },
          h('iframe', {
            ref: frameRef,
            title: '指代器预览',
            sandbox: 'allow-scripts',
            onLoad: () => {
              lastAliveRef.current = Date.now();
              setStatus('wait');
            },
            srcDoc: doc,
            style: { width: '100%', height: '100%', border: 'none', display: 'block', minHeight: 240 },
          }),
          barVisible ? bar : null);
      };
    }
    //#endregion

    return {
      inject: ['slots', 'documentPreviews', 'sessions', 'conversation', 'inputTriggers', 'remote'],
      apply(ctx) {
        const store = createStore();
        const PointerPreview = createPointerPreview(store);

        // Default implementation. 'renderer' loading mounts the body BEFORE DSH reads
        // any bytes, and the body pulls the document from the host route itself, so
        // one implementation serves every size: no 32 MB cliff, and no second mode
        // for the user to discover.
        ctx.effect(() => ctx.documentPreviews.register({
          id: PROVIDER_ID,
          extensions: EXTENSIONS,
          priority: 'extension',
          title: () => '指代页',
          loading: 'renderer',
          wrap: false,
        }), 'dsh-pointer: preview metadata');

        ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
          name: 'sidebar.right.tab.document',
          key: PROVIDER_ID,
          inject: (sessionId) => ({ sessionId, ctx }),
        }, PointerPreview));

        // Compatibility implementation: DSH hands the body the file bytes itself.
        // Kept selectable as a fallback (e.g. if the host route is unavailable) and
        // never chosen by default.
        ctx.effect(() => ctx.documentPreviews.register({
          id: COMPAT_PROVIDER_ID,
          extensions: EXTENSIONS,
          priority: 'extension',
          title: () => '指代页·兼容模式',
          loading: 'bytes-complete',
          wrap: false,
        }), 'dsh-pointer: compat preview metadata');

        ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
          name: 'sidebar.right.tab.document',
          key: COMPAT_PROVIDER_ID,
          inject: (sessionId) => ({ sessionId, ctx }),
        }, PointerPreview));

        ctx.effect(() => ctx.inputTriggers.registerSource(createTriggerSource(store)), 'dsh-pointer: trigger source');

        ctx.effect(() => installSentinelDecorator(store), 'dsh-pointer: transcript sentinel decorator');

        ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
          name: 'sidebar.right.tab.document.actions',
          id: 'dsh-pointer-toggle',
        }, DocPointerAction));
      },
    };
  },
});
