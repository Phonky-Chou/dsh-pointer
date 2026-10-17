# dsh-pointer · WorkBuddy 版

把「指代器」的选中结果接进 **WorkBuddy 5.7.6 桌面版**。

## 一、WorkBuddy 的扩展面调研结论

对本机 `D:\workbody\WorkBuddy\`（v5.7.6，Electron + 原生混合）做的二进制调研：

| 能力 | 证据 | 能否直接做插件 |
|---|---|---|
| **Guest iframe + SDK** | `resources/wb-guest-sdk/wb.js`；宿主 `attachIframe()` 创建 MessageChannel 并 post `__wb_port_init__` | ⚠️ 存在，但 SDK 由宿主从 `https://www.workbuddy.cn/wb.js` 提供 |
| **Buddy Apps** | `app.asar` 内 `.buddy-apps-panel-tabs` 样式、`buddyApps` 桌面通道、`buddyAppsMcpService` | ❌ 包内无 `loadUnpacked` / `devMode` / 本地安装目录约定 → 看起来是**云端注册** |
| **MCP** | `app.asar` 内 `mcpManager`、`mcp:` 命名空间、MCP 设置页 | ✅ **官方标准扩展点，可本地接入** |
| 本地 HTTP 端口 | 7 个 127.0.0.1 监听端口（内部服务） | ⚠️ 未文档化，不建议依赖 |

**结论：WorkBuddy 没有对外开放「往它自己的 HTML 预览里注入脚本」的插件机制。**
所以「在 WorkBuddy 原生预览上直接点到元素」这条路目前走不通 —— 但**指代结果可以通过 MCP 喂给它的 agent**。

## 二、本版本的实现：MCP server

`workbuddy/mcp-server.mjs` —— 零依赖、stdio 传输、每行一个 JSON-RPC 消息。

### 工具

| 工具 | 作用 |
|---|---|
| `pointer_context` | 返回完整指代上下文块（选择器 / 标签 / 文本 / outerHTML / `文件:行号`），格式与 DSH 版**完全一致** |
| `pointer_list` | 紧凑列表（编号 / 类型 / 标签 / 选择器 / 位置），不返回 outerHTML |
| `pointer_clear` | 清除全部指代目标 |

### 数据来源

`~/.dsh/pointer-context.json` —— **与 DSH 版 host 半边是同一个文件**。

因此当前可达成的跨应用工作流：

```
在 DSH 里用「指代器」选中元素/区域
        ↓（自动写入 ~/.dsh/pointer-context.json）
在 WorkBuddy 里对 agent 说「读取当前指代」
        ↓
agent 调 pointer_context 得到选择器 + 文件:行号，然后改代码
```

### 装进 WorkBuddy

WorkBuddy → 设置 → **MCP** → 添加服务器（stdio）：

```
名称：  dsh-pointer
命令：  node
参数：  <本仓库绝对路径>/workbuddy/mcp-server.mjs
```

> 若 `node` 不在 PATH，用 WorkBuddy 自带运行时：
> `D:\workbody\WorkBuddy\resources\vendor\` 下有 `python`、`PortableGit`、`node.zip`；
> 也可以用系统安装的 Node。

### 自测（不依赖 WorkBuddy）

```powershell
$lines = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"pointer_list"}}'
)
$lines | node ./workbuddy/mcp-server.mjs
```

## 三、备选路径（未实现，需要你决策）

要让「在 WorkBuddy 预览里直接框选」成立，只剩 **CDP 注入**：

1. 用 `--remote-debugging-port=9222` 启动 WorkBuddy
2. 通过 Chrome DevTools Protocol 连到预览所在的 webview/renderer
3. 注入探针（与本仓库 `lib/client.js` 里的 probe 同源）
4. 选中结果写回 `~/.dsh/pointer-context.json`，或直接 `Runtime.evaluate` 写进它的输入框

- 优点：能复用现有探针，交互体验与 DSH 版一致
- 缺点：**侵入性强**（要带调试参数重启 WorkBuddy）、依赖内部 DOM 结构、版本升级易碎

## 四、当前状态

- ✅ MCP server：已实现并离线验证（握手 / `tools/list` / 三个工具全部正常）
- ✅ 与 DSH 版共享状态文件，跨应用读取可用
- ⏳ 在 WorkBuddy 里实测：需要你把它加进 MCP 设置后验证
- ❌ 在 WorkBuddy 原生预览里选元素：需要 CDP 方案（见第三节）

## 五、目录约定

本仓库根目录 = **DSH 版**（保持不变，已安装的机器无需迁移）；
`workbuddy/` = **WorkBuddy 版**（新）。两者共享同一份「指代结果」状态文件。
