/**
 * Timing Extension - 显示每次 assistant 生成耗时与会话累计活跃耗时
 *
 * 出处：基于 pi-timing v1.3.0（作者 adamcjm，MIT License）本地修改版
 *       上游项目：https://github.com/adamcjm/pi-timing
 *       本仓库收录仅为个人多机同步，非 fork；修改内容见本目录 README.md
 *
 * 显示（输入框上方 widget，实时更新）：
 *   生成中:   ⏱ 生成中 5.3s (思考≈5.3s)
 *   工具中:   ⏱ 生成 8.2s · 工具运行中 3.5s
 *   结算后:   ⏱ 上次回复 45.2s (生成 12.4s · 思考≈8.1s · 工具 32.8s)  ·  累计活跃 6m12s (42轮)
 *
 * 逐回复标注行（每条最终回复下方，随会话持久化，不进 LLM 上下文）：
 *   ⏱ 耗时 45.2s · 🔧 3 次工具调用
 *   ⏱ 45.2s · 🔧 3 tool calls
 *
 * 口径说明：
 *   - 上次回复总耗时 = 用户消息开始 → 最终回复结束（含中间所有生成与工具执行）
 *   - 生成 = 每次 LLM 流式墙钟（含思考+回复）；思考≈ 为流式中首个非-thinking 增量估算，仅展示不累加
 *   - 工具 = 执行墙钟，并行工具按组只计一次
 *   - 累计活跃 = Σ生成 + Σ工具，不含空闲等待；跨重启由会话 entries 的 timestamp 差重算
 *
 * 命令：
 *   /timing            开关 widget
 *   /timing list       切换最近 20 轮明细列表
 *   /timing lang zh|en|auto   强制语言 / 自动（默认 auto，跟随消息语言）
 *   /timing lines on|off      逐回复标注行开关（默认 on）
 *
 * 多语言：初始取系统 locale（Intl），input 事件按 CJK 占比自动切换中/英。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const MAX_RECENT = 20;

interface TurnDetail {
	genMs: number;
	thinkingMs: number | undefined;
	toolMs: number;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let showDetail = false;
	let showLines = true; // 逐回复标注行（/timing lines 开关）

	// ---- 多语言（auto 跟随用户消息语言；系统 locale 定初始；命令可强制）----
	type LangMode = "auto" | "zh" | "en";
	let langMode: LangMode = "auto";
	let currentLang: "zh" | "en" = detectSystemLang();
	const STRINGS = {
		zh: {
			span: "会话跨度",
			active: "累计活跃",
			roundElapsed: "本轮已耗时",
			generating: "生成中",
			gen: "生成",
			toolRunning: "工具运行中",
			lastReply: "上次回复",
			lastGen: "上次生成",
			none: "--",
			think: "思考≈",
			tool: "工具",
		},
		en: {
			span: "elapsed",
			active: "active time",
			roundElapsed: "turn",
			generating: "generating",
			gen: "gen",
			toolRunning: "tool running",
			lastReply: "last reply",
			lastGen: "last gen",
			none: "--",
			think: "think≈",
			tool: "tool",
		},
	} as const;
	const t = (key: keyof (typeof STRINGS)["zh"]): string => STRINGS[currentLang][key];
	// 轮数后缀（英文区分单复数：1 turn / 2 turns）
	const turnSuffix = (n: number): string =>
		currentLang === "zh" ? "轮" : n === 1 ? " turn" : " turns";

	// ---- 当前生成状态 ----
	let genStartMs = 0;
	let sawThinking = false;
	let thinkingEndMs = 0; // thinking_end 事件时间（思考结束锚点，优先于文本锚点）
	let firstTextMs = 0;
	let lastGenMs = 0;
	let lastThinkingMs: number | undefined;
	let lastToolMs = 0;

	// ---- 当前轮次状态（user 消息 → 最终回复）----
	let roundStartMs: number | undefined;
	let roundGenMs = 0;
	let roundThinkingMs = 0; // 本轮思考累计（结算行展示用）
	let roundToolMs = 0;
	let roundToolCalls = 0; // 当前 LLM 轮工具调用次数（中间轮标注行用）
	let turnToolCalls = 0; // 本轮（user→最终回复）工具总次数（回复行用）
	let lineAppended = false; // 本轮是否已追加回复行（防重）
	let lastReplyMs = 0;
	let lastReplyGenMs = 0;
	let lastReplyToolMs = 0;

	// ---- 工具并行组计时（墙钟，并行只算一次）----
	let activeTools = 0;
	let toolChunkStartMs: number | undefined;

	// ---- 累计 ----
	let cumulativeMs = 0;
	let turns = 0;
	let toolTotalMs = 0;
	let toolCount = 0;
	const recent: TurnDetail[] = [];

	// ---- 会话跨度（首条→末条消息的墙钟，含空闲）----
	let spanFirstTs = 0;
	let spanLastTs = 0;
	const SNAPSHOT_TYPE = "timing-snapshot"; // 运行时精确累计快照（custom entry，不进 LLM 上下文）

	// ---- 工具运行中实时跳秒 ----
	let toolTicker: ReturnType<typeof setInterval> | undefined;

	// ---- message_update 节流（生成中实时跳秒，避免每 token 重建 widget）----
	let lastWidgetUpdate = 0;
	const WIDGET_THROTTLE_MS = 200;

	function throttledUpdate(ctx: ExtensionContext) {
		const now = Date.now();
		if (now - lastWidgetUpdate >= WIDGET_THROTTLE_MS) {
			lastWidgetUpdate = now;
			updateWidget(ctx);
		}
	}

	function detectSystemLang(): "zh" | "en" {
		try {
			const loc = (Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase();
			if (loc.startsWith("zh")) return "zh";
		} catch {
			// ignore
		}
		return "en";
	}

	function detectMsgLang(text: string): "zh" | "en" {
		const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
		return text.length > 0 && cjk / text.length > 0.15 ? "zh" : "en";
	}

	function fmt(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const totalMin = Math.floor(ms / 60_000);
		if (totalMin < 60) {
			// 分钟级：XmYYs（秒位补零）
			const s = Math.round((ms % 60_000) / 1000);
			return `${totalMin}m${String(s).padStart(2, "0")}s`;
		}
		const totalH = Math.floor(totalMin / 60);
		if (totalH < 24) {
			// 小时级：XhYYm（分钟补零）
			return `${totalH}h${String(totalMin % 60).padStart(2, "0")}m`;
		}
		// 天级：XdYYh（小时补零）
		return `${Math.floor(totalH / 24)}d${String(totalH % 24).padStart(2, "0")}h`;
	}

	/** 标注行文案（语言为追加时定格的值，不随后续消息语言变化）
	 *  兼容三种数据形态：round（每轮 AI 输出）/ reply（最终回复）/ 旧版 {ms,...}（pi-replystats 与 v1.2.0） */
	function buildLine(d: {
		kind?: "round" | "reply";
		genMs?: number;
		replyMs?: number;
		ms?: number;
		tools: number;
		lang: "zh" | "en";
	}): string {
		const zh = d.lang === "zh";
		const calls = (n: number) => (zh ? `${n} 次工具调用` : `${n} tool call${n === 1 ? "" : "s"}`);
		if (d.kind === "round" && typeof d.genMs === "number") {
			return zh ? `⏱ 生成 ${fmt(d.genMs)} · 🔧 ${calls(d.tools)}` : `⏱ gen ${fmt(d.genMs)} · 🔧 ${calls(d.tools)}`;
		}
		if (d.kind === "reply" && typeof d.replyMs === "number" && typeof d.genMs === "number") {
			return zh
				? `⏱ 回复 ${fmt(d.replyMs)} · 🔧 ${calls(d.tools)} (生成 ${fmt(d.genMs)})`
				: `⏱ reply ${fmt(d.replyMs)} · 🔧 ${calls(d.tools)} (gen ${fmt(d.genMs)})`;
		}
		const ms = d.ms ?? 0; // 旧版形态
		return zh ? `⏱ 耗时 ${fmt(ms)} · 🔧 ${calls(d.tools)}` : `⏱ ${fmt(ms)} · 🔧 ${calls(d.tools)}`;
	}

	function stopToolTicker() {
		if (toolTicker !== undefined) {
			clearInterval(toolTicker);
			toolTicker = undefined;
		}
	}

	/** 从会话 entries 重算历史基准（跨重启/换分支时调用）
	 *  entries 缺省用 getBranch()（激活消息链）；/tree 导航后传入祖先链（根→leaf），
	 *  使新分支累计包含选中点之前的历史，与重启恢复口径一致。 */
	function recomputeBase(ctx: ExtensionContext, entries?: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>) {
		const branch = entries ?? ctx.sessionManager.getBranch();
		let base = 0;
		let prevTs: number | undefined;
		let pendingAssistantTs: number | undefined;
		let lastToolTs: number | undefined;

		// 最近一轮（用于恢复 lastReply 展示）
		let roundStartMs = 0;
		let roundGen = 0;
		let roundTool = 0;
		let lastReply: TurnDetail | undefined;
		let lastReplyMsLocal = 0;
		let spanFirst = 0;
		let spanLast = 0;
		let snapApplied = false;

		for (const e of branch) {
			// 运行时快照（每轮最终回复时由扩展写入）：链上最后一个生效
			if (e.type === "custom" && e.customType === SNAPSHOT_TYPE && e.data && typeof e.data.cumulativeMs === "number") {
				base = e.data.cumulativeMs;
				turns = typeof e.data.turns === "number" ? e.data.turns : 0;
				lastReplyMsLocal = typeof e.data.lastReplyMs === "number" ? e.data.lastReplyMs : 0;
				lastReply = { genMs: e.data.lastReplyGenMs ?? 0, thinkingMs: undefined, toolMs: e.data.lastReplyToolMs ?? 0 };
				prevTs = typeof e.timestamp === "number" ? e.timestamp : prevTs;
				roundStartMs = 0;
				roundGen = 0;
				roundTool = 0;
				pendingAssistantTs = undefined;
				lastToolTs = undefined;
				snapApplied = true;
				continue;
			}
			if (e.type !== "message") continue;
			const msg = e.message;
			const ts = msg.timestamp;
			if (typeof ts !== "number" || !isFinite(ts)) continue;

			if (spanFirst === 0) spanFirst = ts;
			spanLast = ts;

			if (msg.role === "assistant") {
				// 先结算上一组工具（每组结算，避免中间组丢失）
				if (pendingAssistantTs !== undefined && lastToolTs !== undefined) {
					base += lastToolTs - pendingAssistantTs;
					if (roundStartMs > 0) roundTool += lastToolTs - pendingAssistantTs; // 轮内工具累加
				}
				if (prevTs !== undefined) {
					base += ts - prevTs;
				}
				if (roundStartMs > 0) roundGen += ts - (prevTs ?? roundStartMs);
				pendingAssistantTs = ts;
				lastToolTs = undefined;
				const stop = (msg as { stopReason?: string }).stopReason;
				if (roundStartMs > 0 && stop !== "toolUse") {
					lastReply = { genMs: roundGen, thinkingMs: undefined, toolMs: roundTool };
					lastReplyMsLocal = ts - roundStartMs;
				}
			} else if (msg.role === "toolResult") {
				lastToolTs = lastToolTs === undefined ? ts : Math.max(lastToolTs, ts);
			} else {
				// user / custom 消息：闭合上一组工具，开启新轮
				if (pendingAssistantTs !== undefined && lastToolTs !== undefined) {
					base += lastToolTs - pendingAssistantTs;
					if (roundStartMs > 0) roundTool += lastToolTs - pendingAssistantTs;
				}
				if (snapApplied) turns++;
				roundStartMs = ts;
				roundGen = 0;
				roundTool = 0;
				pendingAssistantTs = undefined;
				lastToolTs = undefined;
			}
			prevTs = ts;
		}
		if (pendingAssistantTs !== undefined && lastToolTs !== undefined) {
			base += lastToolTs - pendingAssistantTs;
			if (roundStartMs > 0) roundTool += lastToolTs - pendingAssistantTs;
		}

		cumulativeMs = Math.max(0, base);
		if (!snapApplied) {
			// 无快照（旧文件）：轮数 = user 消息数
			let userCount = 0;
			for (const e of branch) {
				if (e.type === "message" && e.message.role === "user") userCount++;
			}
			turns = userCount;
		}
		// 会话跨度（首条→末条消息墙钟）
		spanFirstTs = spanFirst;
		spanLastTs = Math.max(spanLastTs, spanLast);
		toolCount = 0; // 历史无法精确统计工具次数，重置为进程内计数
		toolTotalMs = 0;
		// 轮内状态重置：防止 /resume、/tree 切换后残留旧会话的拆解值
		roundStartMs = undefined;
		roundGenMs = 0;
		roundThinkingMs = 0;
		roundToolMs = 0;
		roundToolCalls = 0;
		turnToolCalls = 0;
		lineAppended = false;
		genStartMs = 0;
		sawThinking = false;
		thinkingEndMs = 0;
		firstTextMs = 0;
		activeTools = 0;
		toolChunkStartMs = undefined;
		recent.length = 0; // 旧会话/旧分支的明细不再适用
		if (lastReply) {
			lastReplyMs = lastReplyMsLocal;
			lastReplyGenMs = lastReply.genMs;
			lastReplyToolMs = lastReply.toolMs;
			lastGenMs = lastReply.genMs;
			lastThinkingMs = undefined;
			lastToolMs = lastReply.toolMs;
		} else {
			lastReplyMs = 0;
			lastReplyGenMs = 0;
			lastReplyToolMs = 0;
		}
	}

	/** 重建"根 → 当前 leaf"的祖先链（getEntries 是 append-only 全量树）。
	 *  /tree 导航后 getBranch() 不含选中点之前的历史，用祖先链补全。 */
	function buildAncestorChain(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getEntries();
		const leafId = ctx.sessionManager.getLeafId();
		const byId = new Map(entries.map((e) => [e.id, e]));
		const chain: typeof entries = [];
		let cur = leafId !== undefined ? byId.get(leafId) : undefined;
		while (cur) {
			chain.unshift(cur);
			cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined;
		}
		return chain;
	}

	// ---- widget 渲染 ----

	function updateWidget(ctx: ExtensionContext) {
		if (!enabled) {
			ctx.ui.setWidget("timing", undefined);
			return;
		}

		try {
			ctx.ui.setWidget("timing", (_tui, theme) => {
				const lines: string[] = [];
				const now = Date.now();
				const D = (s: string) => theme.fg("dim", s); // 标签：灰
				const A = (s: string) => theme.fg("accent", s); // 生成/总耗时：强调色
				const T = (s: string) => theme.fg("thinkingHigh", s); // 思考≈：思考紫
				const S = (s: string) => theme.fg("success", s); // 累计：绿

				// 行首（所有状态一致）：累计活跃（已移除会话跨度显示，本地修改版）
				const head = () =>
					D(`⏱ ${t("active")} `) + S(fmt(cumulativeMs)) + D(` (${turns}${turnSuffix(turns)})`);

				// 忙碌状态：行首 + 本轮已耗时（实时跳秒）
				const busyHead = () => {
					let s = head();
					if (roundStartMs !== undefined && roundStartMs > 0) {
						s += D("  ·  " + t("roundElapsed") + " ") + A(fmt(Math.max(0, now - roundStartMs)));
					}
					return s;
				};

				if (genStartMs > 0) {
					// 生成中（实时跳秒，由 message_update 节流驱动刷新）
					const el = now - genStartMs;
					let line = busyHead();
					line += D("  ·  " + t("generating") + " ") + A(fmt(el));
					if (sawThinking && firstTextMs > 0) {
						line += D(` (${t("think")}`) + T(fmt(Math.max(0, firstTextMs - genStartMs))) + D(")");
					}
					lines.push(line);
				} else if (activeTools > 0 && toolChunkStartMs !== undefined) {
					// 工具运行中（interval 驱动跳秒）
					const el = now - toolChunkStartMs;
					let line = busyHead();
					if (turns > 0 || lastGenMs > 0) line += D("  ·  " + t("gen") + " ") + A(fmt(lastGenMs));
					line += D("  ·  " + t("toolRunning") + " ") + A(fmt(el));
					lines.push(line);
				} else {
					// 空闲：行首（会话跨度+累计活跃），其余保持原顺序
					let line = head();
					if (lastReplyMs > 0) {
						line += D("  ·  " + t("lastReply") + " ") + A(fmt(lastReplyMs));
						line += D(` (${t("gen")} `) + A(fmt(lastReplyGenMs));
						if (roundThinkingMs > 0) {
							line += D(` · ${t("think")}`) + T(fmt(roundThinkingMs));
						}
						line += D(` · ${t("tool")} `) + A(fmt(lastReplyToolMs)) + D(")");
					} else if (lastGenMs > 0) {
						line += D("  ·  " + t("lastGen") + " ") + A(fmt(lastGenMs));
					} else {
						line += D(`  ·  ${t("lastReply")} ${t("none")}`);
					}
					lines.push(line);
				}

				if (showDetail && recent.length > 0) {
					lines.push("");
					recent.forEach((r, i) => {
						let l = D(`  #${recent.length - i} ${t("gen")} `) + A(fmt(r.genMs));
						if (r.thinkingMs !== undefined) l += D(`  ${t("think")}`) + T(fmt(r.thinkingMs));
						l += D(`  ${t("tool")} `) + A(fmt(r.toolMs));
						lines.push(l);
					});
				}

				return {
					render: (w: number) => lines.map((ln) => truncateToWidth(ln, w)),
					invalidate: () => {},
				};
			});
		} catch (e) {
			console.error("timing widget error:", e);
		}
	}

	// ---- 事件 ----

	// 逐回复标注行渲染（条目语言在追加时定格）
	// "reply-stats" 兼容旧版 pi-replystats 包写入的历史条目（数据格式相同），删除该包后历史行仍可显示
	const lineRenderer = (entry: { data?: Parameters<typeof buildLine>[0] }, _options: unknown, theme: { fg: (k: string, s: string) => string }) => {
		const d = entry.data ?? { tools: 0, lang: "en" as const };
		const dim = (s: string) => theme.fg("dim", s);
		// 先截断再加颜色，避免 ANSI 序列干扰宽度计算
		return {
			render: (width: number) => [dim(truncateToWidth(buildLine(d), width))],
			invalidate: () => {},
		};
	};
	pi.registerEntryRenderer("timing-line", lineRenderer);
	pi.registerEntryRenderer("reply-stats", lineRenderer);

	pi.on("input", async (event, ctx) => {
		// 自动跟随用户消息语言（斜杠命令和过短输入不触发，避免误切）
		if (langMode !== "auto") return;
		const text = event.text ?? "";
		if (text.startsWith("/") || text.trim().length < 4) return;
		const l = detectMsgLang(text);
		if (l !== currentLang) {
			currentLang = l;
			updateWidget(ctx);
		}
	});

	pi.on("session_start", async (_e, ctx) => {
		recomputeBase(ctx);
		updateWidget(ctx);
	});

	pi.on("session_tree", async (_e, ctx) => {
		recomputeBase(ctx, buildAncestorChain(ctx));
		updateWidget(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role === "user") {
			const nowMs = Date.now();
			if (spanFirstTs === 0) spanFirstTs = nowMs; // 首条消息：会话跨度起点
			roundStartMs = nowMs;
			roundGenMs = 0;
			roundThinkingMs = 0;
			roundToolMs = 0;
			roundToolCalls = 0;
			turnToolCalls = 0;
			lineAppended = false;
			spanLastTs = nowMs; // 新消息提交，会话跨度推进
			turns++;
			return;
		}
		if (event.message.role !== "assistant") return;
		genStartMs = Date.now();
		sawThinking = false;
		thinkingEndMs = 0;
		firstTextMs = 0;
		roundToolCalls = 0; // 新 LLM 轮开始
		updateWidget(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		if (genStartMs === 0) return;
		const ev = event.assistantMessageEvent as { type?: string } | undefined;
		if (!ev || typeof ev.type !== "string") return;
		// 事件类型：thinking_start/delta/end、toolcall_start/delta/end、text_start/delta/end
		if (ev.type === "thinking_start" || ev.type === "thinking_delta") sawThinking = true;
		else if (ev.type === "thinking_end") thinkingEndMs = Date.now();
		else if (firstTextMs === 0 && (ev.type === "text_start" || ev.type === "text_delta")) {
			firstTextMs = Date.now(); // 兜底：首个回复文本 delta
		}
		throttledUpdate(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant" || genStartMs === 0) return;
		// 注意：message.timestamp 是消息创建（流开始）时间戳，不是完成时间；
		// 进程内完成时间用 Date.now()（与会话文件里 timestamp 差值口径一致）
		const endTs = Date.now();
		const genMs = Math.max(0, endTs - genStartMs);
		lastGenMs = genMs;
		const thinkAnchor = thinkingEndMs > 0 ? thinkingEndMs : firstTextMs; // thinking_end 优先，text 兜底
		lastThinkingMs = sawThinking && thinkAnchor > 0 ? Math.max(0, thinkAnchor - genStartMs) : undefined;
		cumulativeMs += genMs;
		roundGenMs += genMs;
		roundThinkingMs += lastThinkingMs ?? 0;

		spanLastTs = Math.max(spanLastTs, endTs); // 回复完成，会话跨度推进
		const stop = (event.message as { stopReason?: string }).stopReason;
		if (roundStartMs !== undefined && stop !== "toolUse") {
			// 最终回复：结算"上次回复总耗时"
			lastReplyMs = Math.max(0, endTs - roundStartMs);
			lastReplyGenMs = roundGenMs;
			lastReplyToolMs = roundToolMs;
			// 持久化精确快照（重启后优先恢复，避免文件时间戳口径误差）
			pi.appendEntry(SNAPSHOT_TYPE, {
				cumulativeMs,
				turns,
				lastReplyMs,
				lastReplyGenMs,
				lastReplyToolMs,
			});
		}

		recent.push({ genMs, thinkingMs: lastThinkingMs, toolMs: roundToolMs });
		if (recent.length > MAX_RECENT) recent.shift();

		genStartMs = 0;
		updateWidget(ctx);
	});

	pi.on("turn_end", async (event) => {
		if (!showLines || roundStartMs === undefined) return;
		// 此时本轮 assistant 消息已持久化：中间轮 entry 落在其工具结果之后，最终轮 entry 落在回复正下方
		const stop = (event.message as { stopReason?: string }).stopReason;
		if (stop === "error" || stop === "aborted") return; // 中断/出错不写行，避免重试产生双行
		if (stop === "toolUse") {
			// 中间轮：每条 AI 输出一行（生成耗时 + 本轮工具次数）
			pi.appendEntry("timing-line", { kind: "round", genMs: lastGenMs, tools: roundToolCalls, lang: currentLang });
			return;
		}
		// 最终回复：回复总耗时（用户消息 → 回复结束）+ 工具总次数 + 末轮生成耗时
		if (lineAppended || lastReplyMs === 0) return;
		lineAppended = true;
		pi.appendEntry("timing-line", {
			kind: "reply",
			replyMs: lastReplyMs,
			genMs: lastGenMs,
			tools: turnToolCalls,
			lang: currentLang,
		});
	});

	pi.on("tool_execution_start", async (_e, ctx) => {
		if (activeTools === 0) {
			toolChunkStartMs = Date.now();
			stopToolTicker();
			toolTicker = setInterval(() => updateWidget(ctx), 500);
		}
		activeTools++;
		roundToolCalls++;
		turnToolCalls++;
		updateWidget(ctx);
	});

	pi.on("tool_execution_end", async (_e, ctx) => {
		activeTools = Math.max(0, activeTools - 1);
		if (activeTools === 0 && toolChunkStartMs !== undefined) {
			const d = Math.max(0, Date.now() - toolChunkStartMs);
			lastToolMs = d;
			toolTotalMs += d;
			cumulativeMs += d; // 累计活跃 = Σ生成 + Σ工具
			toolCount++;
			roundToolMs += d;
			toolChunkStartMs = undefined;
			stopToolTicker();
		}
		updateWidget(ctx);
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		stopToolTicker();
		ctx.ui.setWidget("timing", undefined);
	});

	// ---- 命令 ----

	pi.registerCommand("timing", {
		description: "Toggle timing widget; /timing list = detail; /timing lang zh|en|auto = language; /timing lines on|off = per-reply lines",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim();
			if (a === "list") {
				showDetail = !showDetail;
			} else if (a === "lines" || a.startsWith("lines ")) {
				const v = a.slice(5).trim();
				showLines = v !== "off";
				ctx.ui.notify(`timing lines: ${showLines ? "on" : "off"}`, "info");
			} else if (a.startsWith("lang")) {
				const v = a.slice(4).trim();
				if (v === "zh" || v === "en") {
					langMode = v;
					currentLang = v;
					ctx.ui.notify(`timing language: ${v}`, "info");
				} else if (v === "auto") {
					langMode = "auto";
					currentLang = detectSystemLang();
					ctx.ui.notify(`timing language: auto (${currentLang})`, "info");
				} else {
					ctx.ui.notify(`Usage: /timing lang zh | en | auto (current: ${langMode})`, "info");
				}
			} else {
				enabled = !enabled;
			}
			updateWidget(ctx);
		},
	});
}
