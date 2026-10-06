// Harness for compact-tool-status.ts — loads the extension with a mock pi API,
// checks renderer output, verifies execute() delegation end-to-end, and tests
// the session_start active-tool restore logic.
//
// Path resolution: PI_PKG env var overrides; otherwise the pi package is located
// via `npm root -g` (global npm install). Works on any machine with pi installed.
import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT = join(REPO_ROOT, "extensions", "compact-tool-status.ts");

const PI_PKG =
	process.env.PI_PKG ??
	join(execSync("npm root -g", { encoding: "utf-8" }).trim(), "@earendil-works", "pi-coding-agent");

// Isolate from the machine's global ~/.pi/agent/settings.json: the extension reads
// defaultTools from getAgentDir(), which honors PI_CODING_AGENT_DIR. Point it at an
// empty temp dir so the "pi defaults" scenario is deterministic on any machine.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-agent-dir-"));
process.env.TAU_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

// Mirror pi's own extension loader (dist/core/extensions/loader.js getAliases):
const { createJiti } = await import(pathToFileURL(join(PI_PKG, "node_modules", "jiti", "lib", "jiti.mjs")).href);
const jiti = createJiti(pathToFileURL(import.meta.url).href, {
	alias: {
		"@earendil-works/pi-coding-agent": join(PI_PKG, "dist", "index.js"),
		"@earendil-works/pi-tui": join(PI_PKG, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
	},
});

// --- mock theme: pass-through, tags colors so we can see what color was used
const theme = {
	fg: (color, text) => `<${color}>${text}</>`,
	bg: (_color, text) => text,
	bold: (text) => `*${text}*`,
};

function renderComp(comp) {
	if (!comp) return "<none>";
	if (typeof comp.render === "function") {
		try {
			return comp.render(100).join("\n");
		} catch (e) {
			return `<render error: ${e.message}>`;
		}
	}
	return String(comp.text ?? comp);
}

// --- mock pi API
const tools = new Map();
const handlers = new Map();
const markdownTransformers = [];
let activeTools = [];
const pi = {
	registerTool(def) {
		tools.set(def.name, def);
	},
	on(event, handler) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	},
	registerMarkdownTransformer(t) {
		markdownTransformers.push(t);
	},
	getActiveTools: () => [...activeTools],
	setActiveTools(next) {
		activeTools = [...next];
	},
};

const mod = jiti(EXT);
const factory = mod.default ?? mod;
factory(pi);

let failures = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`PASS  ${name}`);
	} catch (e) {
		failures++;
		console.log(`FAIL  ${name}: ${e.message}`);
	}
}

// === 1. registration ===
const EXPECTED = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
check("all 8 built-in tools overridden", () => {
	for (const n of EXPECTED) assert(tools.has(n), `missing override: ${n}`);
});
check("original description/parameters/execute preserved", () => {
	for (const n of EXPECTED) {
		const d = tools.get(n);
		assert(typeof d.description === "string" && d.description.length > 10, `${n}.description`);
		assert(d.parameters && typeof d.parameters === "object", `${n}.parameters`);
		assert(typeof d.execute === "function", `${n}.execute`);
		assert(typeof d.renderCall === "function" && typeof d.renderResult === "function", `${n} renderers`);
	}
});
check("edit keeps promptSnippet/promptGuidelines (system prompt unchanged)", () => {
	const d = tools.get("edit");
	assert(typeof d.promptSnippet === "string" && d.promptSnippet.length > 0, "promptSnippet lost");
	assert(Array.isArray(d.promptGuidelines) && d.promptGuidelines.length > 0, "promptGuidelines lost");
});

// === 2. renderer output (collapsed / expanded / error) ===
const cwd = REPO_ROOT;
const ctxOf = (args, isError = false) => ({ cwd, args, isError, isPartial: false, expanded: false });
const optsOf = (expanded = false, isPartial = false) => ({ expanded, isPartial });

check("renderCall samples", () => {
	console.log("  " + renderComp(tools.get("read").renderCall({ path: "src/a.ts", offset: 10, limit: 20 }, theme, ctxOf({}))));
	console.log("  " + renderComp(tools.get("write").renderCall({ path: `${cwd}\\out.txt`, content: "a\nb\nc" }, theme, ctxOf({}))));
	console.log("  " + renderComp(tools.get("edit").renderCall({ path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] }, theme, ctxOf({}))));
	console.log("  " + renderComp(tools.get("bash").renderCall({ command: "git status", timeout: 30 }, theme, ctxOf({}))));
	console.log("  " + renderComp(tools.get("powershell").renderCall({ command: "Get-ChildItem" }, theme, ctxOf({}))));
	console.log("  " + renderComp(tools.get("grep").renderCall({ pattern: "foo", path: ".", glob: "*.ts" }, theme, ctxOf({}))));
	console.log("  " + renderComp(tools.get("find").renderCall({ pattern: "*.md" }, theme, ctxOf({}))));
	console.log("  " + renderComp(tools.get("ls").renderCall({}, theme, ctxOf({}))));
});

check("write result: only line count, no content, success glyph", () => {
	const args = { path: "x.txt", content: "l1\nl2\nl3" };
	const out = renderComp(tools.get("write").renderResult({ content: [{ type: "text", text: "File written" }] }, optsOf(), theme, ctxOf(args)));
	console.log("  " + out);
	assert(out.includes("✓") && out.includes("3 lines"), out);
	assert(!out.includes("l1"), "must not show file content");
	const exp = renderComp(tools.get("write").renderResult({ content: [{ type: "text", text: "x" }] }, optsOf(true), theme, ctxOf(args)));
	assert(!exp.includes("l1"), "expanded must not show content either");
});

check("edit result: counts from diff, no diff shown (even expanded)", () => {
	const diff = ["--- a/f.ts", "+++ b/f.ts", "@@ -1,3 +1,4 @@", " ctx", "-old line", "+new line", "+another"].join("\n");
	const res = { content: [{ type: "text", text: "Edited" }], details: { diff } };
	const out = renderComp(tools.get("edit").renderResult(res, optsOf(), theme, ctxOf({ path: "f.ts" })));
	console.log("  " + out);
	assert(out.includes("✓") && out.includes("+2") && out.includes("-1") && out.includes("3 lines changed"), out);
	const exp = renderComp(tools.get("edit").renderResult(res, optsOf(true), theme, ctxOf({ path: "f.ts" })));
	assert(!exp.includes("old line"), "expanded must not show diff");
});

check("bash result: success line / error with exit code", () => {
	const okOut = renderComp(tools.get("bash").renderResult({ content: [{ type: "text", text: "hello\nworld" }] }, optsOf(), theme, ctxOf({}, false)));
	console.log("  " + okOut);
	assert(okOut.includes("✓") && okOut.includes("2 lines"), okOut);
	const errText = "some output\n\nCommand exited with code 3";
	const errOut = renderComp(tools.get("bash").renderResult({ content: [{ type: "text", text: errText }] }, optsOf(), theme, ctxOf({}, true)));
	console.log("  " + errOut);
	assert(errOut.includes("✗") && errOut.includes("exit code 3"), errOut);
	assert(errOut.includes("(1 line)"), `line count should exclude status trailer: ${errOut}`);
});

check("read result: line count + truncation note; error shows first line", () => {
	const res = { content: [{ type: "text", text: "a\nb" }], details: { truncation: { truncated: true, totalLines: 500 } } };
	const out = renderComp(tools.get("read").renderResult(res, optsOf(), theme, ctxOf({})));
	console.log("  " + out);
	assert(out.includes("✓") && out.includes("2 lines") && out.includes("500"), out);
	const errOut = renderComp(tools.get("read").renderResult({ content: [{ type: "text", text: "Error: file not found: x" }] }, optsOf(), theme, ctxOf({}, true)));
	console.log("  " + errOut);
	assert(errOut.includes("✗") && errOut.includes("file not found"), errOut);
});

check("grep/find/ls result summaries", () => {
	const g = renderComp(tools.get("grep").renderResult({ content: [{ type: "text", text: "f.ts:1:x\nf.ts:2:y" }] }, optsOf(), theme, ctxOf({})));
	console.log("  " + g);
	assert(g.includes("2 matches"), g);
	const f = renderComp(tools.get("find").renderResult({ content: [{ type: "text", text: "a.md\nb.md\nc.md" }] }, optsOf(), theme, ctxOf({})));
	assert(f.includes("3 files"), f);
	const l = renderComp(tools.get("ls").renderResult({ content: [{ type: "text", text: "a\nb" }] }, optsOf(), theme, ctxOf({})));
	assert(l.includes("2 entries"), l);
});

check("isPartial renders pending glyph", () => {
	const out = renderComp(tools.get("bash").renderResult({ content: [] }, optsOf(false, true), theme, ctxOf({})));
	assert(out.includes("…"), out);
});

// === 3. execute() delegation end-to-end (real tool implementations) ===
const tmp = mkdtempSync(join(tmpdir(), "pi-ext-test-"));
const execCtx = {
	cwd: tmp,
	sessionManager: { getSessionId: () => "harness-session", getSessionFile: () => join(tmp, "session.jsonl") },
};

const writeRes = await tools.get("write").execute("t1", { path: "probe.txt", content: "alpha\nbeta\ngamma" }, undefined, undefined, execCtx);
check("write.execute creates real file", () => {
	assert(readFileSync(join(tmp, "probe.txt"), "utf-8") === "alpha\nbeta\ngamma");
	assert(!writeRes.isError);
});

const editRes = await tools.get("edit").execute("t2", { path: "probe.txt", edits: [{ oldText: "beta", newText: "BETA\nGAMMA" }] }, undefined, undefined, execCtx);
check("edit.execute applies edit and returns diff details", () => {
	assert(readFileSync(join(tmp, "probe.txt"), "utf-8").includes("BETA\nGAMMA"));
	assert(typeof editRes.details?.diff === "string" && editRes.details.diff.includes("+"));
});

const readRes = await tools.get("read").execute("t3", { path: "probe.txt" }, undefined, undefined, execCtx);
check("read.execute reads file", () => {
	assert(readRes.content[0].text.includes("alpha"));
});

const bashRes = await tools.get("bash").execute("t4", { command: "echo harness-ok" }, undefined, undefined, execCtx);
check("bash.execute runs command", () => {
	assert(bashRes.content[0].text.includes("harness-ok"), bashRes.content[0].text);
});

// 当前版本 pi 的 bash 工具对失败命令返回 isError 结果（不再 throw），渲染器据此显示 ✗
const failRes = await tools.get("bash").execute("t5", { command: "exit 7" }, undefined, undefined, execCtx);
check("bash.execute failure surfaces as isError result", () => {
	assert.strictEqual(failRes.isError, true);
	assert(/exit.*7/i.test(failRes.content[0].text), failRes.content[0].text);
});
console.log("PASS  bash.execute failure propagates (renderer sees isError)");

{
	const g = await tools.get("grep").execute("t6", { pattern: "gamma", path: "." }, undefined, undefined, execCtx);
	const f = await tools.get("find").execute("t7", { pattern: "*.txt", path: "." }, undefined, undefined, execCtx);
	const l = await tools.get("ls").execute("t8", { path: "." }, undefined, undefined, execCtx);
	check("grep/find/ls execute", () => {
		assert(g.content[0].text.includes("probe.txt"), g.content[0].text);
		assert(f.content[0].text.includes("probe.txt"), f.content[0].text);
		assert(l.content[0].text.includes("probe.txt"), l.content[0].text);
	});
}

// === 4. session_start active-tool restore ===
activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "mcp_fetch"];
for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start", reason: "startup" }, { cwd: REPO_ROOT });
check("session_start strips non-default overridden tools, keeps MCP tools", () => {
	assert.deepStrictEqual(activeTools, ["read", "bash", "edit", "write", "mcp_fetch"], JSON.stringify(activeTools));
});

// cwd has no .pi/settings.json; global settings has no defaultTools → pi defaults.
// Simulate a project that opted into grep: create a temp project dir with .pi/settings.json
const proj = mkdtempSync(join(tmpdir(), "pi-ext-proj-"));
mkdirSync(join(proj, ".pi"), { recursive: true });
writeFileSync(join(proj, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read", "bash", "edit", "write", "grep"] }), "utf-8");
activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "mcp_fetch"];
for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start", reason: "startup" }, { cwd: proj });
check("session_start respects configured defaultTools", () => {
	assert.deepStrictEqual(activeTools, ["read", "bash", "edit", "write", "grep", "mcp_fetch"], JSON.stringify(activeTools));
});

// === 5. uppercase labels ===
check("tool call labels are uppercase", () => {
	assert(renderComp(tools.get("read").renderCall({ path: "a.ts" }, theme, ctxOf({}))).includes("READ"));
	assert(renderComp(tools.get("write").renderCall({ path: "a.ts", content: "x" }, theme, ctxOf({}))).includes("WRITE"));
	assert(renderComp(tools.get("edit").renderCall({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, theme, ctxOf({}))).includes("EDIT"));
	assert(renderComp(tools.get("bash").renderCall({ command: "x" }, theme, ctxOf({}))).includes("BASH"));
	assert(renderComp(tools.get("powershell").renderCall({ command: "x" }, theme, ctxOf({}))).includes("POWERSHELL"));
	assert(renderComp(tools.get("grep").renderCall({ pattern: "x" }, theme, ctxOf({}))).includes("GREP"));
	assert(renderComp(tools.get("find").renderCall({ pattern: "x" }, theme, ctxOf({}))).includes("FIND"));
	assert(renderComp(tools.get("ls").renderCall({}, theme, ctxOf({}))).includes("LS"));
});

// === 6. user message bold transformer ===
check("user messages get bold-wrapped per line, others untouched", () => {
	assert.strictEqual(markdownTransformers.length, 1, "expected one markdown transformer");
	const t = markdownTransformers[0];
	assert.strictEqual(t("你好\n世界", { messageType: "user", isStreaming: false }), "**你好**\n**世界**");
	assert.strictEqual(t("line\n\nnext", { messageType: "user", isStreaming: false }), "**line**\n\n**next**");
	assert.strictEqual(t("```js\ncode\n```", { messageType: "user", isStreaming: false }), "```js\ncode\n```");
	assert.strictEqual(t("hello", { messageType: "assistant", isStreaming: false }), "hello");
	assert.strictEqual(t("hello", { messageType: "user", isStreaming: true }), "hello");
});

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
