/**
 * compact-tool-status.ts — pi TUI 工具显示扩展
 *
 * 效果：
 *   1. 所有内置工具调用显示为简洁的单行：大写加粗工具名（READ / WRITE / EDIT /
 *      BASH / POWERSHELL / GREP / FIND / LS）+ 关键参数；
 *      结果行用 ✓（绿）/ ✗（红）明确显示成功或失败，并附简短统计。
 *      工具行保留默认的状态背景色（执行中 / 成功 / 失败），一眼可辨。
 *   2. write / edit 不再显示文件内容或 diff，只显示文件名和总计行数：
 *      write → `✓ wrote 42 lines`，edit → `✓ 15 lines changed (+12 -3)`。
 *   3. 用户输入消息文字「暖黄 + 加粗」，与 AI 输出和工具行明显区分：
 *      加粗由本扩展负责（markdown transformer，仅影响渲染，不改发送内容）；
 *      暖黄色由配套主题 kimi style 负责（theme 层，userMessageText = #FFCB6B）。
 *      两者独立，可分别停用；换主题时文字颜色跟随新主题的 userMessageText。
 *   4. 思考块「结束后立即折叠」：某个思考 run 一旦结束（后续正文/工具调用
 *      已出现）——即正文还在流式输出时——该思考块就折叠为一行 “Thinking...”
 *      标签，而不是等整条消息输出完。鼠标点击单块仍可展开 / 再折叠（组件自带的
 *      thinkingVisibilityOverrides 机制），ctrl+t 全局开关行为不变；消息整体
 *      完成后所有思考块同样折叠。
 *      实现：pi 暂无折叠思考块的公开 API，但 AssistantMessageComponent 由
 *      @earendil-works/pi-coding-agent 入口导出，且扩展经 jiti virtualModules
 *      加载时与交互模式共享同一个类，故在其原型上包一层 updateContent：
 *      流式期间给「已结束」的思考 run 写入隐藏 override（不覆盖用户手动点击），
 *      非流式渲染时临时把实例的 hideThinkingBlock 置为 true。想停用此功能，
 *      删除 entry 里的 patchAutoCollapseThinking() 调用并重启 pi 即可。
 *      （/reload 只能热替换补丁，不能摘除——摘除需要类重建。）
 *
 * 说明：
 *   - 本扩展只重写渲染（renderCall / renderResult）。执行逻辑、参数 schema、
 *     系统提示片段全部沿用 pi 官方工具定义（展开原定义对象，仅追加渲染函数），
 *     不改变任何工具行为。
 *   - 展开式查看（ctrl+o / ctrl+e）对 read / bash / grep / find / ls 仍可用；
 *     write / edit 按需求永不显示内容或 diff。
 *   - MCP 等第三方扩展工具无法通过公开 API 覆盖渲染（拿不到原 execute），
 *     它们保持默认样式（默认样式本身带成功/失败背景色）。
 *
 * 安装（任意电脑）：
 *   1. 本文件        →  ~/.pi/agent/extensions/compact-tool-status.ts
 *   2. 配套主题      →  ~/.pi/agent/themes/kimi style.json
 *   3. settings.json →  "theme": "kimi style"
 *   （只要第 1 步也能用：工具行样式全部生效，用户文字只是不加粗不变色。）
 *   项目级使用则放到  <项目>/.pi/extensions/。临时试用：pi -e ./compact-tool-status.ts
 *
 * 注意：
 *   pi 会把扩展注册的所有同名工具激活（包括默认未启用的 grep/find/ls/powershell）。
 *   为保持「只改 UI」，本扩展在 session_start 时会把这些非默认工具从激活列表移除，
 *   恢复 pi 本身的工具集。若你想常驻启用某些工具，请在 settings.json 配置
 *   "defaultTools": ["read","bash","edit","write","grep",...]，本扩展会尊重该配置。
 *   使用 --tools/-t CLI 参数时本恢复逻辑自动跳过。
 */

import {
	AssistantMessageComponent,
	CONFIG_DIR_NAME,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

const MAX_ERROR_CHARS = 200;
const MAX_EXPANDED_LINES = 100;
const MAX_CMD_CHARS = 160;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function shortPath(p: string, cwd?: string): string {
	if (!p) return "";
	let s = p;
	try {
		if (cwd && isAbsolute(s)) {
			const rel = relative(cwd, s);
			if (rel && !rel.startsWith("..") && !isAbsolute(rel)) s = rel;
		}
		const home = homedir();
		if (s.startsWith(home)) s = `~${s.slice(home.length)}`;
	} catch {
		// keep original
	}
	return s;
}

function firstText(result: any): string {
	const c = result?.content?.find?.((x: any) => x?.type === "text");
	return c?.type === "text" ? (c.text ?? "") : "";
}

function errorText(result: any): string {
	const t = firstText(result).trim();
	if (!t) return "unknown error";
	const line = t.split("\n").find((l) => l.trim()) ?? t;
	return line.length > MAX_ERROR_CHARS ? `${line.slice(0, MAX_ERROR_CHARS - 1)}…` : line;
}

function ok(theme: any, summary: string): Text {
	return new Text(`${theme.fg("success", "✓")} ${summary}`, 0, 0);
}

function bad(theme: any, result: any, reason?: string): Text {
	const msg = reason ?? errorText(result);
	return new Text(`${theme.fg("error", "✗")} ${theme.fg("error", msg)}`, 0, 0);
}

function pending(theme: any): Text {
	return new Text(theme.fg("muted", "…"), 0, 0);
}

function expandedOutput(theme: any, text: string): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const shown = lines.slice(0, MAX_EXPANDED_LINES);
	let out = shown.map((l) => theme.fg("toolOutput", l)).join("\n");
	if (lines.length > shown.length) {
		out += `\n${theme.fg("muted", `… ${lines.length - shown.length} more lines`)}`;
	}
	return out;
}

function countContentLines(text: string): number {
	return text.trim() ? text.trim().split("\n").length : 0;
}

function linesText(n: number): string {
	return n === 1 ? "1 line" : `${n} lines`;
}

function truncationNote(theme: any, details: any): string {
	const tr = details?.truncation;
	if (!tr?.truncated) return "";
	const total = tr.totalLines ? `, ${tr.totalLines} total` : "";
	return theme.fg("warning", ` (truncated${total})`);
}

// ---------------------------------------------------------------------------
// per-tool renderers
// ---------------------------------------------------------------------------

function readRenderers() {
	return {
		call(args: any, theme: any, ctx: any) {
			const p = shortPath(args?.path || "", ctx?.cwd) || "…";
			let text = `${theme.fg("toolTitle", theme.bold("READ"))} ${theme.fg("accent", p)}`;
			if (args?.offset !== undefined || args?.limit !== undefined) {
				const start = args.offset ?? 1;
				const end = args.limit !== undefined ? start + args.limit - 1 : "";
				text += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return new Text(text, 0, 0);
		},
		result(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
			if (isPartial) return pending(theme);
			if (ctx?.isError) return bad(theme, result);
			if (result?.content?.some?.((c: any) => c?.type === "image")) {
				return ok(theme, theme.fg("dim", "image loaded"));
			}
			const text = firstText(result);
			const lines = text === "" ? 0 : text.split("\n").length;
			const summary = theme.fg("dim", linesText(lines)) + truncationNote(theme, result?.details);
			if (!expanded) return ok(theme, summary);
			return new Text(`${theme.fg("success", "✓")} ${summary}\n${expandedOutput(theme, text)}`, 0, 0);
		},
	};
}

function shellRenderers(prompt: string) {
	return {
		call(args: any, theme: any, _ctx: any) {
			const cmd = String(args?.command ?? "…");
			const cmdLines = cmd.split("\n");
			let first = cmdLines[0];
			if (first.length > MAX_CMD_CHARS) first = `${first.slice(0, MAX_CMD_CHARS - 1)}…`;
			let text = `${theme.fg("toolTitle", theme.bold(prompt))} ${theme.fg("accent", first)}`;
			if (cmdLines.length > 1) text += theme.fg("muted", ` (+${cmdLines.length - 1} lines)`);
			if (args?.timeout) text += theme.fg("muted", ` (timeout ${args.timeout}s)`);
			return new Text(text, 0, 0);
		},
		result(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
			if (isPartial) return pending(theme);
			const text = firstText(result);
			const lineCount = countContentLines(text);
			if (ctx?.isError) {
				const exitMatch = text.match(/Command exited with code (-?\d+)/);
				const timeoutMatch = text.match(/timed out after (\d+) seconds/);
				const reason = exitMatch
					? `exit code ${exitMatch[1]}`
					: timeoutMatch
						? `timeout after ${timeoutMatch[1]}s`
						: /aborted/i.test(text)
							? "aborted"
							: errorText(result);
				// pi 的错误文本 = 真实输出 + 空行 + 状态行；行数和展开内容只取真实输出部分
				const trailerMatch = text.match(/\n*\s*(?:Command exited with code -?\d+|Command timed out after \d+ seconds|Command aborted)\s*$/);
				const outputOnly = trailerMatch ? text.slice(0, trailerMatch.index) : text;
				const outLines = countContentLines(outputOnly);
				const head =
					`${theme.fg("error", "✗")} ${theme.fg("error", reason)}` +
					(outLines > 0 ? theme.fg("dim", ` (${linesText(outLines)})`) : "");
				if (!expanded || outLines === 0) return new Text(head, 0, 0);
				return new Text(`${head}\n${expandedOutput(theme, outputOnly)}`, 0, 0);
			}
			const summary = theme.fg("dim", lineCount > 0 ? linesText(lineCount) : "done") + truncationNote(theme, result?.details);
			if (!expanded || lineCount === 0) return ok(theme, summary);
			return new Text(`${theme.fg("success", "✓")} ${summary}\n${expandedOutput(theme, text)}`, 0, 0);
		},
	};
}

function writeRenderers() {
	const lineCountOf = (args: any) => {
		const content = args?.content;
		return typeof content === "string" && content.length > 0 ? content.split("\n").length : 0;
	};
	return {
		call(args: any, theme: any, ctx: any) {
			const p = shortPath(args?.path || "", ctx?.cwd) || "…";
			const n = lineCountOf(args);
			const info = n > 0 ? theme.fg("muted", ` (${linesText(n)})`) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("WRITE"))} ${theme.fg("accent", p)}${info}`, 0, 0);
		},
		// 需求 2：write 永不显示文件内容，只报文件名（call 行）+ 总行数。
		result(_result: any, { isPartial }: any, theme: any, ctx: any) {
			if (isPartial) return pending(theme);
			if (ctx?.isError) return bad(theme, _result);
			const n = lineCountOf(ctx?.args);
			return ok(theme, theme.fg("dim", n > 0 ? `wrote ${linesText(n)}` : "written"));
		},
	};
}

function editRenderers() {
	return {
		call(args: any, theme: any, ctx: any) {
			const p = shortPath(args?.path || "", ctx?.cwd) || "…";
			const n = Array.isArray(args?.edits) ? args.edits.length : 0;
			const info = n > 1 ? theme.fg("muted", ` (${n} edits)`) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("EDIT"))} ${theme.fg("accent", p)}${info}`, 0, 0);
		},
		// 需求 2：edit 永不显示 diff，只报文件名（call 行）+ 总计改动行数。
		result(result: any, { isPartial }: any, theme: any, ctx: any) {
			if (isPartial) return pending(theme);
			if (ctx?.isError) return bad(theme, result);
			const diff = result?.details?.diff as string | undefined;
			if (!diff) return ok(theme, theme.fg("dim", "applied"));
			let added = 0;
			let removed = 0;
			for (const line of diff.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) added++;
				else if (line.startsWith("-") && !line.startsWith("---")) removed++;
			}
			const total = added + removed;
			const summary =
				theme.fg("dim", `${linesText(total)} changed (`) +
				theme.fg("toolDiffAdded", `+${added}`) +
				theme.fg("dim", " ") +
				theme.fg("toolDiffRemoved", `-${removed}`) +
				theme.fg("dim", ")");
			return ok(theme, summary);
		},
	};
}

function grepRenderers() {
	return {
		call(args: any, theme: any, ctx: any) {
			const pattern = args?.pattern || "…";
			const p = shortPath(args?.path || ".", ctx?.cwd);
			let text = `${theme.fg("toolTitle", theme.bold("GREP"))} ${theme.fg("accent", `/${pattern}/`)}`;
			text += theme.fg("toolOutput", ` in ${p}`);
			if (args?.glob) text += theme.fg("muted", ` (${args.glob})`);
			return new Text(text, 0, 0);
		},
		result(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
			if (isPartial) return pending(theme);
			if (ctx?.isError) return bad(theme, result);
			const text = firstText(result);
			const matches = text.split("\n").filter((l) => l.trim() && l.trim() !== "--").length;
			let summary = theme.fg("dim", matches > 0 ? (matches === 1 ? "1 match" : `${matches} matches`) : "no matches");
			const limitReached = result?.details?.matchLimitReached;
			if (limitReached) summary += theme.fg("warning", ` (limit ${limitReached} reached)`);
			summary += truncationNote(theme, result?.details);
			if (!expanded || matches === 0) return ok(theme, summary);
			return new Text(`${theme.fg("success", "✓")} ${summary}\n${expandedOutput(theme, text)}`, 0, 0);
		},
	};
}

function findRenderers() {
	return {
		call(args: any, theme: any, ctx: any) {
			const pattern = args?.pattern || "…";
			const p = shortPath(args?.path || ".", ctx?.cwd);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("FIND"))} ${theme.fg("accent", pattern)}${theme.fg("toolOutput", ` in ${p}`)}`,
				0,
				0,
			);
		},
		result(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
			if (isPartial) return pending(theme);
			if (ctx?.isError) return bad(theme, result);
			const text = firstText(result);
			const files = countContentLines(text);
			let summary = theme.fg("dim", files > 0 ? (files === 1 ? "1 file" : `${files} files`) : "no files");
			const limitReached = result?.details?.resultLimitReached;
			if (limitReached) summary += theme.fg("warning", ` (limit ${limitReached} reached)`);
			if (!expanded || files === 0) return ok(theme, summary);
			return new Text(`${theme.fg("success", "✓")} ${summary}\n${expandedOutput(theme, text)}`, 0, 0);
		},
	};
}

function lsRenderers() {
	return {
		call(args: any, theme: any, ctx: any) {
			const p = shortPath(args?.path || ".", ctx?.cwd);
			return new Text(`${theme.fg("toolTitle", theme.bold("LS"))} ${theme.fg("accent", p)}`, 0, 0);
		},
		result(result: any, { expanded, isPartial }: any, theme: any, ctx: any) {
			if (isPartial) return pending(theme);
			if (ctx?.isError) return bad(theme, result);
			const text = firstText(result);
			const entries = countContentLines(text);
			let summary = theme.fg("dim", entries > 0 ? (entries === 1 ? "1 entry" : `${entries} entries`) : "empty");
			const limitReached = result?.details?.entryLimitReached;
			if (limitReached) summary += theme.fg("warning", ` (limit ${limitReached} reached)`);
			if (!expanded || entries === 0) return ok(theme, summary);
			return new Text(`${theme.fg("success", "✓")} ${summary}\n${expandedOutput(theme, text)}`, 0, 0);
		},
	};
}

// ---------------------------------------------------------------------------
// active-tool restore
// ---------------------------------------------------------------------------

const OVERRIDDEN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const PI_DEFAULT_ACTIVE_TOOLS = ["read", "bash", "edit", "write"];

function readDefaultToolsSetting(cwd: string): string[] | undefined {
	const read = (file: string): string[] | undefined => {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf-8"));
			return Array.isArray(parsed?.defaultTools) ? (parsed.defaultTools as string[]) : undefined;
		} catch {
			return undefined;
		}
	};
	// project-local overrides global (same precedence as pi's settings manager)
	return read(join(cwd, CONFIG_DIR_NAME, "settings.json")) ?? read(join(getAgentDir(), "settings.json"));
}

// ---------------------------------------------------------------------------
// thinking 结束后立即折叠（原型补丁，见文件头说明 4）
// ---------------------------------------------------------------------------

/**
 * 补丁记录挂在原型上（含原始方法引用）。/reload 时扩展重跑但类不重建，
 * 因此重打补丁前先还原原始方法，保证「当前代码版本」生效而不是旧版残留。
 */
const AUTO_COLLAPSE_PATCH = Symbol.for("pi.compact-tool-status.autoCollapseThinking");

/** 复刻 AssistantMessageComponent 的思考分组：连续 thinking 为一组，组内有非空文本才计为一个 run。 */
function collectThinkingRuns(content: any[]): Array<{ start: number; end: number }> {
	const runs: Array<{ start: number; end: number }> = [];
	for (let i = 0; i < content.length; i++) {
		if (content[i]?.type !== "thinking") continue;
		const start = i;
		let hasText = false;
		for (; i < content.length; i++) {
			const c = content[i];
			if (c?.type !== "thinking") break;
			if (typeof c.thinking === "string" && c.thinking.trim()) hasText = true;
		}
		if (hasText) runs.push({ start, end: i - 1 });
		i--;
	}
	return runs;
}

/**
 * 已结束（可自动折叠）的思考 run 下标。判定：该组之后已出现任何内容项
 * （正文 text / toolCall / 下一组思考）。正在流式输出的收尾 run 不满足 → 保持展开。
 * 注意不能用 thinkingSignature 判定：openai-completions 等提供商在 thinking_start
 * 时就写入它（Google/Vertex 流式中途也会写），会导致思考一开始就被折叠。
 */
function finishedThinkingRuns(message: any): number[] {
	const content = message?.content;
	if (!Array.isArray(content)) return [];
	const runs = collectThinkingRuns(content);
	const finished: number[] = [];
	for (let r = 0; r < runs.length; r++) {
		if (runs[r].end < content.length - 1 || r < runs.length - 1) finished.push(r);
	}
	return finished;
}

function patchAutoCollapseThinking(): void {
	try {
		const proto = (AssistantMessageComponent as any)?.prototype;
		if (!proto || typeof proto.updateContent !== "function") return;
		const existing = proto[AUTO_COLLAPSE_PATCH];
		if (existing === true) {
			// 旧版（布尔标记、无原始方法引用）仍残留在原型上，无法在线摘除；
			// 不再叠加，需完全重启 pi 后本版本才会生效。
			return;
		}
		if (existing && typeof existing.original === "function") {
			// 热替换：先还原再重打，/reload 后旧逻辑不残留。
			proto.updateContent = existing.original;
		}
		const original = proto.updateContent;
		proto.updateContent = function (this: any, message: any, isStreaming?: boolean, ...rest: any[]) {
			const streaming = isStreaming ?? this.isStreaming;
			// 思考一结束即折叠该 run。只写入用户未点击过的 run（override 已存在则
			// 尊重用户选择），因此鼠标点击单块展开 / 再折叠的能力完整保留。
			const overrides = this.thinkingVisibilityOverrides;
			if (overrides && typeof overrides.has === "function") {
				for (const r of finishedThinkingRuns(message)) {
					if (!overrides.has(r)) overrides.set(r, true);
				}
			}
			if (streaming) return original.call(this, message, isStreaming, ...rest);
			// 整条消息已完成：全部思考块折叠（含没有后续内容的收尾思考 run）。
			const prev = this.hideThinkingBlock;
			this.hideThinkingBlock = true;
			try {
				return original.call(this, message, isStreaming, ...rest);
			} finally {
				this.hideThinkingBlock = prev;
			}
		};
		proto[AUTO_COLLAPSE_PATCH] = { original };
	} catch {
		// pi 内部结构变化（类未导出 / 方法签名改动）→ 静默跳过，不影响其余功能。
	}
}

// ---------------------------------------------------------------------------
// user message highlight（文字加粗；文字暖黄色由配套主题 kimi style 负责）
// ---------------------------------------------------------------------------

/** 用户输入消息逐行加粗。只影响 TUI 里的渲染，不改动发送给模型的内容。 */
function boldUserMarkdown(markdown: string): string {
	let inFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("```")) {
				inFence = !inFence;
				return line;
			}
			// 跳过空行和代码块内容，避免破坏 markdown 结构
			if (!trimmed || inFence) return line;
			return `**${trimmed}**`;
		})
		.join("\n");
}

// ---------------------------------------------------------------------------
// extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// 思考完成后自动折叠（仅影响渲染；对非 TUI 模式无副作用）。
	patchAutoCollapseThinking();

	const overrides: Array<[string, (cwd: string) => any, any]> = [
		["read", createReadToolDefinition, readRenderers()],
		["bash", createBashToolDefinition, shellRenderers("BASH")],
		["powershell", createPowerShellToolDefinition, shellRenderers("POWERSHELL")],
		["edit", createEditToolDefinition, editRenderers()],
		["write", createWriteToolDefinition, writeRenderers()],
		["grep", createGrepToolDefinition, grepRenderers()],
		["find", createFindToolDefinition, findRenderers()],
		["ls", createLsToolDefinition, lsRenderers()],
	];

	for (const [name, createDef, renderers] of overrides) {
		try {
			// 展开官方工具定义：name/label/description/parameters/promptSnippet/
			// promptGuidelines/constrainedSampling/execute 全部原样保留，只加渲染。
			const def = createDef(cwd);
			pi.registerTool({
				...def,
				// 内置 edit 定义带 renderShell:"self"（为自己的 diff 边框服务）；
				// 我们的渲染器用统一默认外壳，以保留 执行中/成功/失败 的状态背景色。
				renderShell: "default",
				renderCall: renderers.call,
				renderResult: renderers.result,
			});
		} catch {
			// 该平台不可用（如非 Windows 上的 powershell）→ 跳过此工具的覆盖。
		}
	}

	pi.on("session_start", (_event, ctx) => {
		// pi 会激活所有扩展注册的同名工具；恢复 pi 原本的激活工具集，保持纯 UI 改动。
		try {
			const toolsFlagUsed = process.argv.some((a) => a === "--tools" || a === "-t" || a.startsWith("--tools="));
			if (!toolsFlagUsed) {
				const keep = new Set(readDefaultToolsSetting(ctx.cwd) ?? PI_DEFAULT_ACTIVE_TOOLS);
				const active = pi.getActiveTools();
				const next = active.filter((n) => !OVERRIDDEN_TOOL_NAMES.includes(n) || keep.has(n));
				if (next.length !== active.length) pi.setActiveTools(next);
			}
		} catch {
			// best effort
		}
	});

	// 用户输入消息文字加粗（颜色由配套主题 compact-dark 的 userMessageText 负责）。
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "user" || context.isStreaming) return markdown;
		return boldUserMarkdown(markdown);
	});
}
