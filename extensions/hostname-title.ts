/**
 * Hostname Title Extension
 *
 * 在 pi 默认的终端窗口标题基础上追加主机名，方便区分 SSH 到不同机器的会话。
 *
 * pi 默认标题: "π - [会话名 - ]目录名"
 * 加载本扩展后: "π - [会话名 - ]目录名 - [user@]hostname"
 *
 * pi 会在启动、新建/切换会话、会话改名时重设标题，
 * 所以这里挂了相同的事件，并在其后重新应用一次。
 */

import * as os from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// 只显示 @机器名
	const host = `@${os.hostname()}`;

	const applyTitle = (ctx: ExtensionContext) => {
		// 仅交互模式有效；RPC/无 UI 模式下 setTitle 是 no-op 或不存在
		if (ctx.mode !== "tui") return;

		const cwdBasename = basename(ctx.sessionManager.getCwd());
		const sessionName = ctx.sessionManager.getSessionName();
		// 与 pi 内置逻辑保持一致（APP_TITLE 默认为 "π"）
		const base = `π${sessionName ? ` - ${sessionName}` : ""} - ${cwdBasename}`;
		const title = `${base} - ${host}`;

		ctx.ui.setTitle(title);
		// pi 自身的事件处理器可能在扩展之后运行并覆盖标题，延迟再补一次
		const timer = setTimeout(() => ctx.ui.setTitle(title), 50);
		timer.unref?.();
	};

	pi.on("session_start", (_event, ctx) => applyTitle(ctx));
	pi.on("session_info_changed", (_event, ctx) => applyTitle(ctx));
	pi.on("session_tree", (_event, ctx) => applyTitle(ctx));
}
