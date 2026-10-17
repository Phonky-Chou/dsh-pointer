# dsh-pointer · 技术底座设计

> 在 DSH 内预览可预览文件时，提供统一「指代器」：左键选中元素/对象、右键框选区域，
> 把**结构 + 源码位置**投递给当前 Agent。
> 文件类型可替换，投递目标（Agent）可替换 —— 本插件后续也要能接进 work buddy。

---

## 1. 三条硬约束（从三个现成插件的实战踩坑得来）

1. **不能注入 DSH 内置预览**。内置 HTML 预览是 `<iframe data-html-preview sandbox="allow-scripts">` 的
   不透明源，父页面拿不到 `contentDocument`。任何插件都注不进去。
   → 结论：**插件注册自己的预览实现**，不去碰内置的那个。

2. **沙箱不能降级**。不能为了注入方便改成 `allow-same-origin`，那会让用户 HTML 能访问
   DSH 的 DOM / storage。→ 结论：探针**跑在沙箱里**，用 `postMessage` 跨源通信。

3. **拾取粒度由「表面能否 DOM 化」决定**。能转成 HTML 的文档就能选元素；
   不能转的（位图、扫描件）只能框区域。这条是类型扩展的**判据**，不是实现细节。

---

## 2. 分层架构

```
┌──────────────────────────── DSH 客户端 ────────────────────────────┐
│  documentPreviews.register(metadata)                                │
│    └─ Provider Registry  ← 可热加（声明式 / 代码式）                 │
│         └─ PreviewBody(id)                                          │
│              └─ Surface  ├─ sandbox iframe (srcdoc / blob)          │
│                          └─ canvas / img (region-only)              │
│                   └─ Probe（注入脚本，自包含）                       │
│                        │  postMessage（协议 v1）                     │
│                        ▼                                            │
│                   Probe Bridge（宿主侧状态机）                        │
│                        │                                            │
│                        ▼                                            │
│                   Pick Sink Registry                                │
│                     ├─ dsh-chip    输入框引用 chip（主）             │
│                     ├─ dsh-route   路由 + 上下文块（兜底）           │
│                     └─ external    WS / 约定文件（work buddy）       │
└─────────────────────────────────────────────────────────────────────┘
```

设计要点：**Surface 之上的一切与文件类型无关**。新增一种文件类型 = 新增一个 Provider，
它只要能把内容变成 `SurfaceSpec`，就自动获得 hover / 选中 / 框选 / 投递能力。

---

## 3. 关键接口

### 3.1 SurfaceSpec（载体）

```ts
type SurfaceSpec =
  | { kind: 'srcdoc';  html: string; sandbox?: string }      // HTML/SVG/md→HTML
  | { kind: 'blob';    url: string;  sandbox?: string }      // 大文档，避免 srcdoc 转义
  | { kind: 'canvas';  width: number; height: number;        // 位图：region-only
                        draw: 'image' | 'pdf-pages'; src: string }
```

统一要求：
- 探针脚本由**框架注入**（不是每个 provider 自己写），provider 不需要知道探针存在；
- 必须能回 `ready` 握手（带 capabilities），UI 状态以握手为准。

### 3.2 PreviewProvider

```ts
interface PreviewProvider {
  id: string
  extensions: string[]                 // ['html','htm']
  binaryExtensions?: string[]          // 不能按文本读的后缀
  priority: 'extension' | 'builtin'    // extension 优先于内置
  title: () => string
  loading: 'text-pages' | 'bytes-complete' | 'renderer'
  wrap?: boolean

  capabilities: {
    element: boolean       // 能选 DOM 元素
    region: boolean        // 能框选区域
    sourceMap: boolean     // 能给出 文件:行:列
  }

  surface(input: PreviewInput): SurfaceSpec | Promise<SurfaceSpec>

  /** 可选：DOM 节点 → 源码位置 */
  locate?(snapshot: ElementSummary, src: PreviewSource): SourceLocation | null
}
```

**两种扩展形态**（对应「文件类型可替换」）：

| 形态 | 作者 | 是否需要重启 | 适用 |
|---|---|---|---|
| **声明式** `{ transform, pipeline }` | Agent 自己就能产出 | 否（落盘即生效） | 类型转换：csv→表格、pdf→png、docx→html |
| **代码式** `provider.js` (client bundle) | 人工 | 是 | 复杂渲染：pdf.js 分页、office 预览 |

### 3.3 Probe 协议 v1

```ts
// probe → host
{ v:1, t:'ready',  caps:{element,region,sourceMap}, surface:{w,h} }
{ v:1, t:'hover',  el: ElementSummary | null }
{ v:1, t:'pick',   mode:'element'|'region',
                   items: ElementSummary[], region?: Rect, text?: string }
{ v:1, t:'error',  message: string, phase:'install'|'runtime' }

// host → probe
{ v:1, t:'mode',      mode:'off'|'element'|'region' }
{ v:1, t:'highlight', selector?: string }
```

```ts
interface ElementSummary {
  selector: string
  tag: string; id: string; classes: string[]; role?: string
  text: string            // ≤500
  outerHTML: string       // ≤8KB
  rect: Rect
  styles: Record<string,string>   // 子集：display/position/color/background/font/margin/padding/border
  loc?: { file: string; line: number; column: number }
}
```

协议本身是**唯一跨端契约**。DSH、work buddy、外部 Agent 都只认这份 payload，
换 Agent 不需要动探针和 provider。

### 3.4 PickSink（投递端可替换）

```ts
interface PickSink {
  id: string
  available(): boolean
  deliver(p: PointerPayload): Promise<{ ok: boolean; error?: string }>
}
```

内置三个，**双适配是刻意的版本韧性设计**（`dsh-plugin-browser` 那次的教训：单一 API 漂移就整块崩）：

| sink | 机制 | 角色 |
|---|---|---|
| `dsh-chip` | `inputTriggers.registerSource` + `conversation.input.insertReference`，插入「元素N」引用 chip | 主路径，最贴近原生引用体验 |
| `dsh-route` | 自有 HTTP 路由 + systemPrompt 上下文块（`ctx.systemPrompt.context`） | 兜底：chip API 变了一行代码就能切 |
| `external` | 写入 `~/.dsh/dsh-pointer/inbox/*.json` + 可配 WS 广播 | work buddy / 外部 Agent |

### 3.5 指代器开关

DSH 的预览头部有 `sidebar.right.tab.document.actions` 槽（内置「在应用中打开」就挂在这），
开关注册在这里，三态：

```
关  →  选元素  →  框区域
```

- 状态**按 tab 保存**（与 DSH 其他 tab 偏好一致）；
- 开关的可用项由 provider 的 `capabilities` 决定（只有 region 的 provider 不显示「选元素」）；
- 首次 ready 前显示「准备中」，ready 后才可点 —— **状态不撒谎**（element-context 那次「探针就绪但轮询不跑」的反面教材）。

---

## 4. 文件类型矩阵

| 类型 | 表面 | 拾取粒度 | 源映射 | 依赖 |
|---|---|---|---|---|
| `html` `htm` | srcdoc iframe | DOM 元素 | ✅ outerHTML→源码偏移→行:列 | 无 |
| `svg` | srcdoc iframe | DOM 元素 | ✅ 同上 | 无 |
| `md` `markdown` | md→HTML | 块/行内元素 | ✅ 渲染时打 `data-src-line` | markdown 渲染器 |
| `txt` `log` | `<pre>` 按行分块 | **行**（每行一个元素） | ✅ 行号天然 | 无 |
| `json` `yaml` `toml` | 语法高亮 HTML | 行/键 | ✅ 行号 | 轻量高亮（可省） |
| `csv` `tsv` | 转 HTML 表格 | 单元格 | ⚠️ 行列可推 | 无 |
| `png` `jpg` `webp` `gif` | `<img>`/canvas | **仅区域** | ❌ | 无 |
| `pdf` | pdf.js 渲染 + text layer | 文本块 / 区域 | ✅ 页码+文本偏移 | pdf.js（可选代码式 provider） |
| `docx` `xlsx` `pptx` | 转 HTML 或 PDF | 视转换结果 | 走转换层 | DSH 已有 `office-to-pdf` |
| 其它 / 未知 | 纯文本兜底 | 行 | ✅ 行号 | 无 |

**兜底原则**：任何无法识别的类型，一律用纯文本 provider 呈现，至少保证「选行 → 行号」可用。
不会出现「打不开」的黑洞。

---

## 5. Agent 自扩展（「给 AI 自主兼容的空间」）

### 5.1 两级扩展

1. **声明式**（Agent 优先走这条）：只描述「怎么把字节变成 HTML/图片」，不写前端代码。
   ```json
   { "id": "pdf-via-pdftoppm", "ext": ["pdf"],
     "pipeline": [{ "cmd": "pdftoppm", "args": ["-png","-r","144"] }],
     "surface": "image-series",
     "capabilities": { "element": false, "region": true, "sourceMap": false } }
   ```
   落盘即生效（provider registry 热加载），**不需要重启**。

2. **代码式**：完整 client bundle，需用户显式批准 + 重启 DSH。

### 5.2 宿主工具（Agent 可调用）

```ts
pointer_provider_list()                                  // 现有 provider + 能力
pointer_provider_probe({ ext })                          // 该类型能否预览、缺什么
pointer_provider_add({ ext, pipeline, capabilities ... })// 声明式登记
pointer_provider_remove({ id })
pointer_preview_open({ path })                           // 打开/聚焦预览 tab
```

### 5.3 典型自愈流程（你举的 PDF 例子）

```
1. 用户打开 report.pdf
2. 无内置 pdf provider → 预览显示「不支持」+ 一句提示
3. Agent: pointer_provider_probe({ext:'pdf'}) → { previewable:false, missing:'renderer' }
4. Agent 自行探测本机转换器：pdftoppm / libreoffice / DSH 的 office-to-pdf
5. Agent: pointer_provider_add({ ext:'pdf', pipeline:[...], capabilities:{region:true} })
6. 预览立刻切到新 provider，框选可用；区域可转成图片附件投递
```

### 5.4 安全边界（自扩展必须受限）

- 转换在**受限子进程**执行：超时、内存上限、输出大小上限、**默认无网络**；
- provider 落盘在 `~/.dsh/dsh-pointer/providers/`，`pipeline` 只允许白名单命令；
- 代码式 provider 必须显式批准（与 DSH 插件权限模型一致）；
- 探针回传数据做结构校验 + 大小上限（`outerHTML ≤ 8KB`、`items ≤ 64`）。

---

## 6. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** 底座 + html | Provider 框架、探针、协议、`dsh-chip` sink、左键选中、源码行号 | 预览里点元素 → chip → Agent 收到「选择器 + 文件:行号」 |
| **P1** 区域框选 | 右键拖框、marquee、命中元素集合、多选合并 | 框住一块 → 投递「区域 N + 命中元素列表」 |
| **P2** 多类型 | md / txt / svg / 未知兜底 + 相对资源内联 | 4 种类型都能选 |
| **P3** 位图 + PDF | image（region-only）、pdf.js provider、区域转图片 | 图片/PDF 框选可用 |
| **P4** 可替换性 | `external` sink、声明式 provider 热加载、Agent 工具、work buddy 接入 | Agent 自己加一个 provider 并生效 |

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| DSH 前端 API 漂移（0.1.x→0.2.0 已见） | 双 sink（chip + route）；预览实现只依赖 `documentPreviews` 这一个稳定契约 |
| 相对资源内联（兄弟 css/js/图片） | P0 先不做且**明确提示**；P2 接 `addResource/setResources` |
| 用户 HTML 自带 CSP 挡注入脚本 | 注入到 `<head>` 最前；注入失败则回 `error: install` 并提示（不假装就绪） |
| 大文件注入开销 | > 2MB 走 `blob` 表面 + 分块文本 provider |
| 探针与宿主消息风暴 | hover 节流（rAF + 16ms）、尺寸上限、只回传摘要 |
| 右键框选在触控板不可用 | `Shift+左键` 等价入口 |

---

## 8. 目录结构

```
dsh-pointer/
  package.json                # dsh.bundle.patch + dsh.client{platform:web}
  cordis.patch.yml            # insert: id=dsh-pointer
  src/
    host/index.ts             # 工具注册(provider_*)、路由兜底、inbox 落盘
    client/
      index.ts                # documentPreviews 注册 + tab actions 开关
      preview/PointerPreview.tsx   # 统一 Surface 容器
      providers/
        registry.ts           # 运行时注册表（声明式热加载）
        html.ts markdown.ts text.ts image.ts fallback.ts
      probe/
        install.ts            # 自包含探针（序列化注入）
        protocol.ts selector.ts sourcemap.ts region.ts highlight.ts
      sinks/
        dsh-chip.ts dsh-route.ts external.ts
  docs/DESIGN.md
```

---

## 9. Spike 实测结果（全部跑完，DSH 0.2.0-rc.2）

| # | 验证项 | 结论 | 对设计的影响 |
|---|---|---|---|
| 1 | `content` 字段形状 | ✅ `bytes-complete` → `{kind:'bytes', data}`；`text-pages` → `{kind:'text', pages, text, eof}`；`renderer` → `{kind:'renderer', revision, loaded, failed, reload}` | provider 按 `loading` 三态分支处理 |
| 2 | `addResource/setResources` | ⚠️ 它们是**依赖追踪**，不是内联：`addResource(address)`、`setResources(addresses)` 只登记「兄弟文件变化要重载」。真正内联要自己实现 `readRelated`（`ctx.remote.workspaceFiles.readBytes`）+ 自建 blob URL | **修正**：相对资源内联是 provider 自己的活，P2 必做项 |
| 3 | `priority` 排序 | ✅ `rank = priority === 'builtin' ? 0 : 1`；同 rank 按更长后缀 → 注册顺序；注册表保留全部备选（下拉可切） | 用 `priority:'extension'` 即默认高于内置，内置仍可切回 |
| 4 | chip 插入 API | ✅ 完整可用：`ctx.sessions.binding(id)` → `ctx.conversation.input.for(binding.ctx)` → `input.insertReference({source, ref, label, clipboardText, appearance:'session'}, {start, end, draftRev})`；配合 `inputTriggers.registerSource({trigger:'@', name, order, candidates, onPick, lexicon, subscribeLexicon, codec:{clipboardText, serialize}})` | `dsh-chip` sink 可按此实现，无需兜底 |
| 5 | 沙箱 `postMessage` | ✅ 真浏览器实测通过：`sandbox="allow-scripts"` + srcdoc 脚本可运行、消息可达（`event.origin=null`）、**20KB 载荷正常**、父页面访问被 `SecurityError` 阻断（隔离成立） | 探针方案成立。**副产品**：`location.href=about:srcdoc`、`origin=null` → srcdoc 内相对 URL 解析不了 → 资源必须内联（升为硬要求） |
| 6 | `sidebar.right.tab.document.actions` 槽 | ⚠️ 注册形状已知（`slots.inject(...)` + `slots.register({name,id,locale,inject}, Comp)`），body props 未完全确认 | **对策**：开关先做成预览内的浮动控件（自包含、零跨槽状态），actions 槽作为后续增强 |

### 两条设计修正（已并入上文）

1. **相对资源内联从「可选项」升为「P2 必做」**：srcdoc 的 base 是 `about:srcdoc`，`<img src="./x.png">` 会解析失败。
2. **开关默认放预览内**，不依赖 actions 槽，减少一个未知依赖。

> spike 全程用临时 profile + 本地静态页 + 内置浏览器完成，**未改动 desktop profile，未重启 DSH**。
