/**
 * binary-context-footer.ts — 把 footer 里的 token 数值从 10 进制（1000 进位，k/M）
 * 改成 2 进制（1024 进位，Ki/Mi），其余布局、配色尽量与内置 footer 保持一致。
 *
 * 加载即生效（session_start 时挂载）；`/ctx-units` 可在二进制 footer 与
 * 内置默认 footer 之间切换。
 *
 * 与内置 footer 的已知差异（扩展拿不到的数据）：
 * - 虚拟模型路由显示（`→ 物理模型`）无法获取，不显示；
 * - Kimi Coding 订阅按 provider === "kimi-coding" 近似判断；
 * - 实验特性 "xp" 指示不显示。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const K = 1024;
const M = 1024 * 1024;

/** 1024 进位格式化：<1024 原样，<10Ki 一位小数，<1Mi 取整 Ki，<10Mi 一位小数 Mi，再往上取整 Mi */
function formatTokens(count: number): string {
	if (count < K) return `${count}`;
	if (count < 10 * K) return `${(count / K).toFixed(1)}Ki`;
	if (count < M) return `${Math.round(count / K)}Ki`;
	if (count < 10 * M) return `${(count / M).toFixed(1)}Mi`;
	return `${Math.round(count / M)}Mi`;
}

/** 与内置 formatCwdForFooter 一致：HOME 内的路径缩写为 ~ 相对路径 */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	if (cwd === home) return "~";
	if (cwd.startsWith(home + "/") || cwd.startsWith(home + "\\")) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function createUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals: UsageTotals, usage: any): void {
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

export default function (pi: ExtensionAPI) {
	let enabled = true; // 加载即启用；/ctx-units 切换

	pi.registerCommand("ctx-units", {
		description: "切换 footer 上下文单位（Ki 二进制 / 内置十进制）",
		getArgumentCompletions: () => [],
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				installBinaryFooter(ctx);
				ctx.ui.notify("上下文单位已切换为二进制（Ki/Mi）", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("已恢复内置 footer（十进制 k/M）", "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) installBinaryFooter(ctx);
	});

	function installBinaryFooter(ctx: any) {
		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const lines: string[] = [];

					// ---- 第一行：pwd (+ git 分支 + 会话名) ----
					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;
					lines.push(truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")));

					// ---- 第二行：token 统计 + 上下文 ----
					// 与内置 FooterComponent 相同口径：全量 entries 的 usage 累加
					const totals = createUsageTotals();
					let latestCacheHitRate: number | undefined;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "usage") {
							addUsage(totals, entry.usage);
						} else if (entry.type === "message" && entry.message.role === "assistant") {
							addUsage(totals, entry.message.usage);
							const promptTokens =
								entry.message.usage.input +
								entry.message.usage.cacheRead +
								entry.message.usage.cacheWrite;
							latestCacheHitRate =
								promptTokens > 0 ? (entry.message.usage.cacheRead / promptTokens) * 100 : undefined;
						} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
							addUsage(totals, entry.message.usage);
						} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
							addUsage(totals, entry.usage);
						}
					}

					const statsParts: string[] = [];
					if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
					if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
						statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
					}
					// Kimi Coding 是订阅制（近似：provider 判断）
					const usingSubscription = ctx.model?.provider === "kimi-coding";
					if (totals.cost || usingSubscription) {
						statsParts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}

					// 上下文占用：已用/窗口 (百分比) [auto]（二进制单位）
					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const percentValue = usage?.percent ?? 0;
					const autoIndicator = (pi.getSettings().compaction?.enabled ?? true) ? " [auto]" : "";
					const tokensStr = usage?.tokens == null ? "?" : formatTokens(usage.tokens);
					const percentStr = usage?.percent == null ? "?" : `${percentValue.toFixed(1)}%`;
					const display = `${tokensStr}/${formatTokens(contextWindow)} (${percentStr})${autoIndicator}`;
					const contextColored =
						percentValue > 90
							? theme.fg("error", display)
							: percentValue > 70
								? theme.fg("warning", display)
								: display;
					statsParts.push(contextColored);

					let statsLeft = statsParts.join(" ");

					// ---- 右侧：模型名 + 思考级别（+ provider，多 provider 且放得下时）----
					const modelName = ctx.model?.id || "no-model";
					let rightSide: string;
					if (ctx.model?.reasoning) {
						const level = ctx.thinkingLevel || "off";
						rightSide = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
					} else {
						rightSide = modelName;
					}
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						const withProvider = `(${ctx.model.provider}) ${rightSide}`;
						if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) {
							rightSide = withProvider;
						}
					}

					// ---- 排版：左统计 + 右对齐模型 ----
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}
					const rightSideWidth = visibleWidth(rightSide);
					let statsLine: string;
					if (statsLeftWidth + 2 + rightSideWidth <= width) {
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - 2;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					// 与内置 footer 相同：分段加 dim，避免内部色码打断外层 dim
					const dimStatsLeft = theme.fg("dim", statsLeft);
					const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));
					lines.push(dimStatsLeft + dimRemainder);

					// ---- 第三行（如有）：扩展 setStatus 文本 ----
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const sorted = Array.from(statuses.entries() as Iterable<[string, string]>)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text));
						lines.push(truncateToWidth(sorted.join(" "), width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	}
}
