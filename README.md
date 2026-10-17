# dsh-pointer（指代器）

在 DeepSeek Harness 的文档预览里直接「指代」UI 元素：**左键选中元素、右键拖拽框选区域**，
把结构化信息 + **源码行号** 送进对话，模型据此精确定位要改的代码。

## 能力

- **自注册预览实现**：插件注册自己的 `html` / `htm` 渲染器（`priority: 'extension'`），
  内置预览仍可从渲染器下拉切回 —— 不侵入、可卸载。
- **沙箱探针**：内容渲染在 `srcdoc` 沙箱 iframe 里，探针用 `postMessage` 回传；
  用户页面无法接触 DSH 页面（不降级为 `allow-same-origin`）。
- **左键选元素 / 右键框选区域**：预览内保留带编号的高亮标记，编号与输入框 chip 一一对应。
- **相对资源内联**：外链 CSS → `<style>`、图片/字体 → `data:` URL、CSS 内 `url()` 也一并内联，
  因此带外部依赖的真实项目也能正常预览。
- **源码定位**：元素 → `文件:行:列`；内联后会把 `data:` URL 还原成原始引用再匹配源码。
- **双通道投递**：输入框引用 chip（主）+ host 路由上下文块（兜底）；发送后消息里仍显示为 chip。
- **悬停联动**：输入框里悬停 chip，预览中对应标记变为黄色光晕。

## 安装（Windows）

前提：DeepSeek Harness 桌面版已安装，并**至少启动过一次**（需要它生成 profile 配置）。

```powershell
git clone https://github.com/Phonky-Chou/dsh-pointer.git
cd dsh-pointer
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会自动完成三件事：

1. 从注册表定位 DSH 安装目录
2. 把 `cordis.patch.yml` 里的插件入口写成本机绝对路径
3. 调用 DSH 自带的 CLI 把插件装进 `desktop` profile

装完**重启 DeepSeek Harness**（host 与客户端包都在启动时加载）。

> 脚本会本地改写 `cordis.patch.yml` 的入口路径，所以 `git status` 会显示该文件被修改 ——
> 这是预期行为，提交时不用带上。

其它 profile / 卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile desktop
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

<details>
<summary>手动安装（脚本不适用时）</summary>

1. 把 `cordis.patch.yml` 里的 `name` 改成本机 `<repo>/lib/index.js` 的绝对路径
2. `dsh plugin --profile desktop add <repo>`
3. 重启 DSH

</details>

## 使用

1. 在 DSH 右侧栏用**预览**方式打开一个 `.html` 文件（默认会走「指代页」渲染器）。
2. 点顶部工具栏的 **`◉ 指代器`** 进入指代模式。
3. **左键**点页面元素 → 输入框出现「元素N」；**右键拖拽**框选区域 → 出现「区域N」。
4. 把 chip 写进句子发送；模型收到选择器、标签、文本、outerHTML 与 `文件:行:列`。

`▾` 展开角标可查看探针状态、本次已选数量，并可一键清除全部标记。

## 已知限制

- 目前只接管 `html` / `htm`；`md` / `txt` / `svg` / PDF 等尚未接入（后续按 provider 扩展）。
- 探针只覆盖主 frame，不穿透嵌套 iframe；Shadow DOM 只能选到宿主元素。
- 位图、canvas 内绘制的图形没有 DOM 元素可指代（只能框选区域坐标）。
- 单个元素的 `outerHTML` 在上下文块里截断到 2KB。
- 仅验证于 DeepSeek Harness `0.2.0-rc.2`（Windows）。

## 开发

```
lib/index.js     host 半边：上下文块 + `/dsh-pointer/pick`、`/dsh-pointer/inline` 路由
lib/inline.js    host 侧相对资源内联（fs 直接读盘）
lib/client.js    client 半边：预览实现、探针、chip 投递、渲染层 chip 装饰
docs/DESIGN.md   技术底座设计（分层、协议、类型扩展方案）
examples/        验证夹具（含外链 CSS / SVG / CSS 内 url()）
install.ps1      一键安装/卸载
```

## License

MIT
