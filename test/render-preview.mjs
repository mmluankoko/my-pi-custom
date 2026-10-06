// Renders the REAL ToolExecutionComponent + theme with the extension's overridden
// tool definitions — approximates what the pi TUI will draw (ANSI stripped copy shown).
//
// Path resolution: PI_PKG env var overrides; otherwise the pi package is located
// via `npm root -g` (global npm install). Works on any machine with pi installed.
import { join } from "node:path";
import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXT = join(REPO_ROOT, "extensions", "compact-tool-status.ts");

const PI_PKG =
	process.env.PI_PKG ??
	join(execSync("npm root -g", { encoding: "utf-8" }).trim(), "@earendil-works", "pi-coding-agent");

const { createJiti } = await import(pathToFileURL(join(PI_PKG, "node_modules", "jiti", "lib", "jiti.mjs")).href);
const jiti = createJiti(pathToFileURL(import.meta.url).href, {
	alias: {
		"@earendil-works/pi-coding-agent": join(PI_PKG, "dist", "index.js"),
		"@earendil-works/pi-tui": join(PI_PKG, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
	},
});

const { ToolExecutionComponent } = await import(pathToFileURL(join(PI_PKG, "dist", "modes", "interactive", "components", "tool-execution.js")).href);
const { withBuiltInRenderers } = await import(pathToFileURL(join(PI_PKG, "dist", "core", "tools", "renderers", "index.js")).href);
const { initTheme } = await import(pathToFileURL(join(PI_PKG, "dist", "modes", "interactive", "theme", "theme.js")).href);
initTheme("dark", false);

const tools = new Map();
const pi = { registerTool: (d) => tools.set(d.name, d), on: () => {}, registerMarkdownTransformer: () => {}, getActiveTools: () => [], setActiveTools: () => {} };
(jiti(EXT).default ?? jiti(EXT))(pi);

const mockUi = { requestRender: () => {} };
const cwd = REPO_ROOT;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function scenario(label, name, args, result) {
	const def = withBuiltInRenderers(name, tools.get(name));
	const comp = new ToolExecutionComponent(name, "tc1", args, { showImages: false }, def, mockUi, cwd);
	comp.markExecutionStarted();
	comp.setArgsComplete();
	if (result) comp.updateResult(result, false);
	const lines = comp.render(80);
	console.log(`--- ${label} ---`);
	for (const l of lines) console.log(process.env.PI_PREVIEW_RAW ? JSON.stringify(l) : strip(l).replace(/\s+$/, ""));
	console.log("");
}

scenario("write ok", "write", { path: "src\\demo.ts", content: "a\nb\nc\nd" }, { content: [{ type: "text", text: "File written" }], isError: false });
scenario("edit ok (diff hidden)", "edit", { path: "src\\demo.ts", edits: [{ oldText: "a", newText: "b\nc" }] }, {
	content: [{ type: "text", text: "Edited" }],
	details: { diff: "--- a\n+++ b\n-old\n+new\n+more" },
	isError: false,
});
scenario("edit error", "edit", { path: "src\\demo.ts", edits: [{ oldText: "zzz", newText: "q" }] }, {
	content: [{ type: "text", text: "Error: oldText not found in file. Must match exactly." }],
	isError: true,
});
scenario("bash ok", "bash", { command: "npm test", timeout: 60 }, { content: [{ type: "text", text: "all 12 tests passed" }], isError: false });
scenario("bash fail (exit 2)", "bash", { command: "npm test" }, { content: [{ type: "text", text: "FAIL src/a.spec.ts\n\nCommand exited with code 2" }], isError: true });
scenario("read ok", "read", { path: join(REPO_ROOT, "extensions", "compact-tool-status.ts"), offset: 1, limit: 40 }, { content: [{ type: "text", text: "l1\nl2\nl3" }], details: {}, isError: false });
scenario("MCP-style tool (default fallback, untouched)", "mcp_fetch", { url: "https://example.com" }, { content: [{ type: "text", text: "page contents…" }], isError: false });
