#!/usr/bin/env node
/**
 * Regenerate market/index.json — the DSH plugin-market index (format 1).
 *
 * DSH 0.2.1+ reads this file from an HTTP(S) URL added under
 * 插件 → 发现 → 添加索引源. Every published npm version of this package becomes an
 * entry, so releasing a new version only needs: npm publish → node scripts/build-market-index.mjs.
 *
 * Usage:
 *   node scripts/build-market-index.mjs            # write market/index.json
 *   node scripts/build-market-index.mjs --check    # exit 1 when the file is stale
 *
 * Validation: if @deepseek-ai/dsh-plugin-market-index happens to be resolvable, the
 * generated document is parsed with the real validator before it is written.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'market/index.json');
const CHECK = process.argv.includes('--check');

/** Placeholder the npm staged-publishing flow leaves behind; never list it. */
const IGNORED_VERSIONS = new Set(['0.0.0-stage']);

/** 64×64 SVG icon: a page outline plus a crosshair (the "pick an element" idea). */
const ICON = 'data:image/svg+xml;base64,' + Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
  + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
  + '<stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>'
  + '<rect width="64" height="64" rx="14" fill="url(#g)"/>'
  + '<rect x="12" y="10" width="30" height="38" rx="4" fill="none" stroke="#fff" stroke-width="3" opacity="0.9"/>'
  + '<line x1="19" y1="21" x2="35" y2="21" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.9"/>'
  + '<line x1="19" y1="29" x2="31" y2="29" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.7"/>'
  + '<line x1="19" y1="37" x2="33" y2="37" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.7"/>'
  + '<circle cx="43" cy="43" r="11" fill="none" stroke="#fff" stroke-width="3"/>'
  + '<line x1="43" y1="28" x2="43" y2="35" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'
  + '<line x1="43" y1="51" x2="43" y2="58" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'
  + '<line x1="28" y1="43" x2="35" y2="43" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'
  + '<line x1="51" y1="43" x2="58" y2="43" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'
  + '</svg>',
  'utf8',
).toString('base64');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const registry = pkg.publishConfig?.registry ?? 'https://registry.npmjs.org';
const meta = await fetchJson(`${registry}/${pkg.name}`).catch(() => null);

if (!meta) {
  console.error(`[market] cannot read ${pkg.name} from ${registry}`);
  process.exit(1);
}

const versions = Object.keys(meta.versions ?? {})
  .filter((version) => !IGNORED_VERSIONS.has(version))
  .filter((version) => meta.time?.[version] !== undefined)
  .map((version) => ({
    version,
    publishTimestamp: Math.floor(Date.parse(meta.time[version]) / 1000),
    source: { type: 'npm' },
  }))
  .sort((left, right) => compareVersionsDesc(left.version, right.version));

if (versions.length === 0) {
  console.error('[market] no published npm version found');
  process.exit(1);
}

const index = {
  format: 1,
  title: { en: 'Phonky Plugins', zh: 'Phonky 插件市场' },
  description: {
    en: 'Community DSH plugins maintained by Phonky-Chou. Currently: an in-preview element pointer (指代器).',
    zh: 'Phonky-Chou 维护的 DSH 社区插件。当前包含：在预览中直接圈选元素的「指代器」。',
  },
  metadata: {
    categories: { interface: { title: { en: 'Interface', zh: '界面与体验' } } },
    labels: {
      preview: { title: { en: 'Preview', zh: '预览' } },
      html: { title: { en: 'HTML', zh: 'HTML' } },
      agent: { title: { en: 'Agent', zh: '智能体' } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Element Pointer (指代器)', zh: '指代器' },
      description: {
        en: 'Pick elements inside a document preview (left-click an element, right-drag a region) and hand the agent a selector, outerHTML and file:line — no more describing "that card".',
        zh: '在 DSH 的文档预览里左键选元素、右键拖拽框选区域，把选择器、outerHTML 与 文件:行号 精确交给 agent —— 不用再向模型描述「那个卡片」。',
      },
      icon: ICON,
      author: 'Phonky-Chou',
      homepage: 'https://github.com/Phonky-Chou/dsh-pointer',
      repository: { url: 'https://github.com/Phonky-Chou/dsh-pointer' },
      metadata: {
        category: 'interface',
        keywords: ['element picker', 'preview', 'html', 'selector', 'source line', '指代器', '元素选择'],
        labels: ['preview', 'html', 'agent'],
      },
      versions,
    },
  ],
};

// Validate with the real validator when it is resolvable.
let validator;
try {
  validator = await import('@deepseek-ai/dsh-plugin-market-index');
} catch {
  console.warn('[market] validator not installed — skipping parse check (optional)');
}
if (validator) {
  validator.parseMarketIndex(index, 'https://gitee.com/z_xl7974/dsh-pointer/raw/master/market/index.json');
}

const serialized = JSON.stringify(index, null, 2) + '\n';
if (CHECK) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== serialized) {
    console.error('[market] market/index.json is stale — rerun without --check');
    process.exit(1);
  }
  console.log('[market] market/index.json is up to date');
  process.exit(0);
}

writeFileSync(OUT, serialized, 'utf8');
console.log(`[market] wrote ${OUT} with versions ${versions.map((v) => v.version).join(', ')}`);
if (validator) console.log('[market] validated with @deepseek-ai/dsh-plugin-market-index');

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Descending order for the version records; enough for plain `x.y.z[-pre]` versions. */
function compareVersionsDesc(left, right) {
  const core = (value) => value.split('-')[0].split('.').map(Number);
  const [la, lb] = [core(left), core(right)];
  for (let index = 0; index < 3; index += 1) {
    const [na, nb] = [la[index] ?? 0, lb[index] ?? 0];
    if (na !== nb) return nb - na;
  }
  const preLeft = left.includes('-');
  const preRight = right.includes('-');
  if (preLeft !== preRight) return preLeft ? 1 : -1;
  return left < right ? 1 : left > right ? -1 : 0;
}
