/**
 * model-in-system-prompt.ts — 在系统提示词末尾注入当前模型信息
 *
 * 效果：
 *   每次 agent 运行前，在系统提示词末尾追加一行：
 *     Current model: Qwen27B-vision-120K (provider: Q27)
 *   （display name 与 id 不同时为：Current model: <name> (<provider>/<id>)）
 *
 * 缓存说明：
 *   - before_agent_start 事件携带的永远是 pi 的「基线」系统提示词
 *     （emitBeforeAgentStart 传入 _baseSystemPrompt，不含上轮覆盖），
 *     因此本扩展每次追加得到的结果逐字节一致，不会随轮次累积、不会漂移。
 *   - 同一 session 不换模型 → 系统提示词完全稳定 → prompt 缓存前缀不受影响。
 *   - 换模型 → 该行变化 → 缓存前缀失效；但换模型本来就换缓存命名空间，无损失。
 *   - 追加在系统提示词末尾（最后一块），对 Anthropic 前缀缓存最友好。
 *
 * 停用：删除本文件，或把文件移出 ~/.pi/agent/extensions/ 后 /reload。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		try {
			const model = ctx.model;
			if (!model) return; // 尚未配置模型时不注入
			const line =
				model.name && model.name !== model.id
					? `Current model: ${model.name} (${model.provider}/${model.id})`
					: `Current model: ${model.provider}/${model.id}`;
			// 防御：理论上 event.systemPrompt 永远是基线不含此行；保险起见避免重复追加。
			if (event.systemPrompt.includes(line)) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${line}` };
		} catch {
			// best effort：注入失败不影响正常运行
		}
	});
}
