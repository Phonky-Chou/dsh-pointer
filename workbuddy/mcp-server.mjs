#!/usr/bin/env node
/**
 * dsh-pointer · WorkBuddy 版 —— MCP server（stdio）
 *
 * 为什么是 MCP
 * ------------
 * 对 WorkBuddy 5.7.6（Electron）做了二进制调研，结论：
 *   - 第三方扩展面是 **MCP**（包内 `app.asar` 出现 `mcpManager`、`buddyAppsMcpService`）
 *   - 存在 guest iframe 体系（`attachIframe` + MessageChannel + `__wb_port_init__`），
 *     但 SDK 由宿主从 `https://www.workbuddy.cn/wb.js` 提供，Buddy App 看起来是
 *     **云端注册**的，包内没有 `loadUnpacked` / `devMode` / 本地安装目录约定。
 *
 * 因此本版本把「指代结果」通过 MCP 暴露给 WorkBuddy 的 agent：
 *   - 采集仍由 dsh-pointer 的探针完成（在能注入预览的环境里，如 DSH）
 *   - WorkBuddy 侧通过 MCP 工具读取/清理这些指代结果
 *
 * 共享状态文件：~/.dsh/pointer-context.json（与 DSH 版 host 半边同一个文件，
 * 所以「在 DSH 里选好元素 → 在 WorkBuddy 里让 agent 读取」是即插即用的）。
 *
 * 用法（在 WorkBuddy 的 MCP 设置里添加一个 stdio 服务器）：
 *   command: node
 *   args:    ["<repo>/workbuddy/mcp-server.mjs"]
 *
 * 协议：MCP stdio = 每行一个 JSON-RPC 消息。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const CONTEXT_PATH = join(homedir(), '.dsh', 'pointer-context.json');
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'dsh-pointer', version: '0.1.0' };

function readItems() {
  try {
    const parsed = JSON.parse(readFileSync(CONTEXT_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === 'object') : [];
  } catch {
    return [];
  }
}

function writeItems(list) {
  mkdirSync(dirname(CONTEXT_PATH), { recursive: true });
  writeFileSync(CONTEXT_PATH, JSON.stringify(list, null, 2) + '\n', 'utf8');
}

/** Same text shape as the DSH host block, so one mental model for both apps. */
function renderContext(items) {
  if (items.length === 0) return '<pointer_context count="0"></pointer_context>';
  const lines = ['<pointer_context count="' + items.length + '">'];
  items.forEach((item, index) => {
    const label = item.label || '元素' + (index + 1);
    const loc = item.loc && item.loc.file
      ? item.loc.file + (item.loc.line ? ':' + item.loc.line : '')
      : item.file || '';
    if (item.mode === 'region') {
      lines.push('<pointer_target kind="region">');
      lines.push('  Label: ' + label);
      if (loc) lines.push('  SourceLocation: ' + loc);
      if (item.selector) lines.push('  Selector: ' + item.selector);
      if (item.tag) lines.push('  Tag: <' + item.tag + '>');
      if (item.text) lines.push('  TextContent: ' + JSON.stringify(item.text));
      lines.push('  OuterHTML: ' + String(item.outerHTML ?? '').slice(0, 600));
      lines.push('</pointer_target>');
    } else {
      lines.push('<pointer_target>');
      lines.push('  Label: ' + label);
      if (loc) lines.push('  SourceLocation: ' + loc);
      if (item.selector) lines.push('  Selector: ' + item.selector);
      if (item.tag) lines.push('  Tag: <' + item.tag + '>');
      if (item.text) lines.push('  TextContent: ' + JSON.stringify(item.text));
      lines.push('  OuterHTML: ' + String(item.outerHTML ?? '').slice(0, 2000));
      lines.push('</pointer_target>');
    }
  });
  lines.push('</pointer_context>');
  return lines.join('\n');
}

const TOOLS = [
  {
    name: 'pointer_context',
    description:
      '读取当前由「指代器」选中的元素/区域，返回带选择器、标签、文本、outerHTML 与 文件:行号 的上下文块。'
      + '用户说「这个元素」「这块区域」时先调用它，再用其中的 Selector/SourceLocation 定位代码。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pointer_list',
    description: '以紧凑列表形式返回当前指代目标（编号、标签、选择器、文件:行号），不返回 outerHTML。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pointer_clear',
    description: '清除当前所有指代目标（用户说「清掉刚才的标记」时使用）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function callTool(name) {
  if (name === 'pointer_context') return textResult(renderContext(readItems()));
  if (name === 'pointer_list') {
    const items = readItems();
    if (items.length === 0) return textResult('（当前没有指代目标）');
    const rows = items.map((item, index) => {
      const label = item.label || '元素' + (index + 1);
      const loc = item.loc && item.loc.file
        ? item.loc.file + (item.loc.line ? ':' + item.loc.line : '')
        : item.file || '';
      const kind = item.mode === 'region' ? '区域' : '元素';
      return [index + 1, kind, label, item.selector || item.tag || '', loc].join(' | ');
    });
    return textResult('编号 | 类型 | 标签 | 选择器 | 位置\n' + rows.join('\n'));
  }
  if (name === 'pointer_clear') {
    writeItems([]);
    return textResult('已清除全部指代目标。');
  }
  throw new Error('unknown tool: ' + name);
}

function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    if (method === 'notifications/initialized' || method === 'initialized') return null;
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (method === 'tools/call') {
      const name = params && params.name;
      try {
        return { jsonrpc: '2.0', id, result: callTool(name) };
      } catch (error) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '错误：' + String(error && error.message ? error.message : error) }], isError: true } };
      }
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (isRequest) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
    }
    return null;
  } catch (error) {
    return isRequest
      ? { jsonrpc: '2.0', id, error: { code: -32603, message: String(error && error.message ? error.message : error) } }
      : null;
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const responses = Array.isArray(message) ? message.map(handle).filter(Boolean) : [handle(message)].filter(Boolean);
  for (const response of responses) process.stdout.write(JSON.stringify(response) + '\n');
});
process.stdin.on('end', () => process.exit(0));
