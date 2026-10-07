# pi-custom

为 [pi coding agent](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent`）编写的个人扩展与主题合集。

包含 **2 个扩展**（1 个原创 + 1 个第三方本地修改版）和 **1 个主题**：

| 文件 | 类型 | 简介 |
|---|---|---|
| [`extensions/compact-tool-status.ts`](extensions/compact-tool-status.ts) | 扩展（原创） | 内置工具单行紧凑渲染 + 思考块自动折叠 + 用户消息加粗 |
| [`extensions/timing/`](extensions/timing/README.md) | 扩展（第三方修改版） | 基于 [pi-timing](https://github.com/adamcjm/pi-timing) v1.3.0（MIT）本地修改：隐藏会话跨度显示 |
| [`themes/kimi style.json`](themes/kimi%20style.json) | 主题（原创） | Kimi 风格深色主题（暖黄用户消息、蓝色强调） |

## 安装

把文件复制到 pi 的全局目录（或项目级 `.pi/` 目录）：

```bash
# 扩展（原创单文件 + timing 目录）
cp extensions/compact-tool-status.ts ~/.pi/agent/extensions/
cp -r extensions/timing ~/.pi/agent/extensions/

# 主题
cp "themes/kimi style.json" ~/.pi/agent/themes/
```

然后在 `~/.pi/agent/settings.json` 里启用主题：

```json
{ "theme": "kimi style" }
```

重启 pi（或 `/reload`）即可生效。`compact-tool-status.ts` 单独使用也可（工具行样式全部生效，用户文字只是不加粗不变色）。

临时试用单个扩展：`pi -e ./extensions/compact-tool-status.ts`

## 各项说明

### compact-tool-status.ts

只重写渲染、不改工具行为的 UI 扩展：

1. **单行工具显示**：READ / WRITE / EDIT / BASH / POWERSHELL / GREP / FIND / LS 大写加粗 + 关键参数；结果行 ✓（绿）/ ✗（红）+ 简短统计（行数 / 匹配数 / exit code 等）。
2. **write / edit 不显示内容与 diff**：write → `✓ wrote 42 lines`；edit → `✓ 15 lines changed (+12 -3)`。
3. **用户消息加粗**（暖黄色由配套主题 `kimi style` 的 `userMessageText` 提供，两者独立可分别停用）。
4. **思考块结束后立即折叠**：思考 run 一结束（后续正文 / 工具调用已出现）即折叠为一行，不等整条消息输出完；鼠标点击单块仍可展开 / 再折叠，`ctrl+t` 全局开关不变。通过对 `AssistantMessageComponent.prototype.updateContent` 打原型补丁实现，支持 `/reload` 热替换。

细节：

- 展开式查看（`ctrl+o` / `ctrl+e`）对 read / bash / grep / find / ls 仍可用。
- 内置工具定义（description / parameters / execute / 系统提示片段）原样展开保留，仅追加渲染函数。
- session_start 时会把本扩展注册的同名非默认工具（grep / find / ls / powershell）从激活列表移除，恢复 pi 默认工具集；尊重 `settings.json` 的 `defaultTools` 配置，使用 `--tools/-t` CLI 参数时自动跳过。
- MCP 等第三方扩展工具无法通过公开 API 覆盖渲染，保持默认样式。

### timing/（第三方本地修改版）

基于 [pi-timing](https://github.com/adamcjm/pi-timing) v1.3.0（作者 adamcjm，MIT License）：在输入框上方显示每次生成的耗时（含思考估算）、工具耗时、累计活跃时间，并逐回复标注耗时行。详见 [`extensions/timing/README.md`](extensions/timing/README.md)。

本仓库收录仅为个人多机同步，不是 fork；与上游的唯一差异是 widget 行首移除「会话跨度」显示。感谢上游作者。

### kimi style 主题

深色主题，蓝 / 青 / 暖黄配色，与 compact-tool-status 配套（用户消息暖黄加粗）。可独立使用。

## 测试

`test/` 目录是 compact-tool-status 的开发用测试脚本（自动定位 pi 全局安装路径，无需改路径）：

```bash
node test/run-checks.mjs        # 渲染器输出 / execute 委托 / 工具激活恢复 / markdown 变换 全量断言
node test/render-preview.mjs    # 用真实 ToolExecutionComponent 渲染各场景预览（ANSI 已剥离）
```

## License

MIT
