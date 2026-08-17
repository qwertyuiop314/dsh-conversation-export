#!/usr/bin/env node
/**
 * build-plugin.cjs — 生成 DSH 插件包 @deepseek-ai/dsh-session-conversation-export
 *
 * 客户 bundle（lib/client.js）的转换核心逻辑直接从 session-conversation-gui.html 的
 * <script id="core-logic"> 提取，保证与已测试的 GUI/CLI 版逐字节一致。
 *
 * 用法: node build-plugin.cjs
 * 输出: plugin/@deepseek-ai/dsh-session-conversation-export/{package.json, lib/index.js, lib/client.js}
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'plugin', '@deepseek-ai', 'dsh-session-conversation-export');
const GUI = path.join(ROOT, 'session-conversation-gui.html');

// ---------- 1. 提取 GUI 中已测试的核心逻辑 ----------
const html = fs.readFileSync(GUI, 'utf8');
const m = html.match(/<script id="core-logic">([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到 core-logic 脚本'); process.exit(1); }
let core = m[1];
// 去掉末尾的 window.__dshConvCore 暴露块（插件 bundle 内不需要）
core = core.replace(/\n\/\* 暴露给测试\/外部使用[\s\S]*$/, '');

// ---------- 2. package.json ----------
const pkg = {
  name: '@deepseek-ai/dsh-session-conversation-export',
  version: '0.1.0',
  description: 'Web 导出对话：在 Session 头部（Session log 左侧）一键把会话日志清洗并转换为对话记录（Markdown / 纯文本 / HTML / JSON / JSONL / OpenAI 格式），打包 ZIP 下载',
  type: 'module',
  main: './lib/index.js',
  exports: {
    '.': './lib/index.js',
    './client': './lib/client.js',
    './package.json': './package.json'
  },
  dsh: {
    client: { platform: 'web' },
    // bundle 声明：dsh plugin add 后由 reconcile 自动加入 profile bundles 层，
    // cordis.patch.yml 注入装载条目 —— 真正的一条命令安装。
    bundle: { patch: './cordis.patch.yml' }
  },
  files: ['lib', 'cordis.patch.yml'],
  license: 'MIT'
};

// 包内 patch：注入插件装载条目（bundle 层随 profile 启动时应用）
const bundlePatch = `# dsh-session-conversation-export bundle patch:
# 由 dsh plugin add 安装后经 reconcile 加入 dsh.profile.bundles，启动时应用本层，
# 注入 Export chat 插件装载条目（无需再手动改 profile 的 cordis.patch.yml）。
- insert:
    - id: session-conversation-export
      name: '@deepseek-ai/dsh-session-conversation-export'
`;

// ---------- 3. 宿主半部（最小 cordis 插件：转换全在浏览器完成） ----------
const host = `/**
 * Host half of dsh-session-conversation-export.
 *
 * 转换逻辑完全在浏览器端执行（fetch /api/session.export 的 ZIP → 本地清洗 → 打包下载），
 * 宿主侧无需任何服务；本入口存在的意义是让 Cordis Loader 装载该包，从而
 * client-modules 扫描到 dsh.client 声明并挂载浏览器 bundle。
 */
const name = "session-conversation-export";
function apply(ctx) {
	ctx.effect(() => () => {}, "session-conversation-export: browser-only feature");
}
export { apply, name };
`;

// ---------- 4. 浏览器 bundle 模板 ----------
const clientTemplate = `window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-session-conversation-export",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region 核心逻辑（与 session-to-conversation.cjs / GUI 完全一致）
__CORE__
		//#endregion
		//#region 头部导出按钮
		/** 可选导出格式（键 / 显示名 / 扩展名）。 */
		const CONV_FORMATS = [
			["md", "Markdown", ".md"],
			["txt", "纯文本", ".txt"],
			["html", "网页 HTML", ".html"],
			["json", "结构化 JSON", ".json"],
			["jsonl", "逐行 JSON", ".jsonl"],
			["openai", "OpenAI 格式", ".openai.json"]
		];
		/** 格式键 → [渲染函数, 文件名后缀, MIME]。 */
		const CONV_KIND_MAP = {
			md: [renderMarkdown, "conversation.md", "text/markdown;charset=utf-8"],
			txt: [renderPlainText, "conversation.txt", "text/plain;charset=utf-8"],
			html: [renderHtmlPage, "conversation.html", "text/html;charset=utf-8"],
			json: [renderJson, "conversation.json", "application/json;charset=utf-8"],
			jsonl: [renderJsonl, "conversation.jsonl", "application/x-ndjson;charset=utf-8"],
			openai: [renderOpenAI, "conversation.openai.json", "application/json;charset=utf-8"]
		};

		function downloadBlob(name, blob) {
			const anchor = document.createElement("a");
			anchor.href = URL.createObjectURL(blob);
			anchor.download = name;
			document.body.appendChild(anchor);
			anchor.click();
			setTimeout(() => { URL.revokeObjectURL(anchor.href); anchor.remove(); }, 1500);
		}

		/**
		* 导出当前 Session：fetch /api/session.export ZIP → 本地清洗重建 → 按所选格式下载。
		* @param sessionId - 当前 Session id。
		* @param kinds - 所选格式键数组（如 ["md","json"]）；单个文件直接下载，多个打包 ZIP。
		* @returns 汇总信息。
		*/
		async function exportConversation(sessionId, kinds, optsOverride) {
			const origin = globalThis.location?.origin !== void 0 && globalThis.location.origin !== "null" ? globalThis.location.origin : "http://dsh.internal";
			const url = new URL("/api/session.export", origin);
			url.searchParams.set("sessionId", sessionId);
			url.searchParams.set("includeDescendants", "true");
			const response = await fetch(url, { method: "GET" });
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new Error("导出失败: HTTP " + response.status + (detail === "" ? "" : " " + detail));
			}
			const buf = await response.arrayBuffer();
			const entries = await readZipEntries(buf);
			// 优先按文件名匹配 .jsonl（兼容 .jsonl.zstd）；兜底按内容嗅探（"type":"session" 头行）
			let jsonls = entries.filter((e) => /\\.jsonl(\\.zstd)?$/i.test(e.name));
			if (jsonls.length === 0) {
				jsonls = [];
				for (const e of entries) {
					const probe = new TextDecoder().decode(e.data.slice(0, 4096));
					if (probe.includes('"type":"session"')) jsonls.push(e);
				}
			}
			if (jsonls.length === 0) throw new Error("导出包中没有找到会话日志（*.jsonl），请确认当前会话有持久化记录");
			const opts = Object.assign({ keepPlugin: false, reasoning: true, tools: true, maxToolResult: 2000 }, optsOverride || {});
			const convs = [];
			let broken = 0;
			for (const entry of jsonls) {
				const parsed = parseEvents(new TextDecoder().decode(entry.data));
				broken += parsed.broken;
				const conv = buildConversation(parsed.events, opts);
				conv.meta.sourceFile = entry.name;
				if (!conv.meta.title) conv.meta.title = conv.meta.sessionId ? "会话 " + conv.meta.sessionId.slice(0, 8) : "(未命名会话)";
				convs.push(conv);
			}
			const files = [];
			for (const conv of convs) {
				const base = safeName(conv.meta.title || "session");
				for (const k of kinds) {
					const spec = CONV_KIND_MAP[k];
					if (spec === void 0) continue;
					files.push({ name: base + "." + spec[1], data: new TextEncoder().encode(spec[0](conv, opts)), mime: spec[2] });
				}
			}
			if (files.length === 1) {
				downloadBlob(files[0].name, new Blob([files[0].data], { type: files[0].mime }));
			} else if (files.length > 1) {
				const zipName = convs.length === 1
					? safeName(convs[0].meta.title || "session") + ".conversation.zip"
					: "dsh-conversations-" + convs.length + "-sessions.zip";
				downloadBlob(zipName, makeStoreZip(files.map((f) => ({ name: f.name, data: f.data }))));
			}
			return { files: files.length, sessions: convs.length, broken };
		}

		/** Session 头部按钮 + 导出弹窗（勾选格式，位于 Session log 左侧）。 */
		function ConversationExportButton({ sessionId }) {
			const [phase, setPhase] = react.useState("idle");
			const [detail, setDetail] = react.useState("");
			const [selected, setSelected] = react.useState({ md: true, txt: false, html: false, json: false, jsonl: false, openai: false });
			const [contentOpts, setContentOpts] = react.useState({ reasoning: true, tools: true });
			const busy = phase === "busy";
			const open = phase !== "idle";
			const pickedCount = CONV_FORMATS.filter(([k]) => selected[k]).length;
			const allOn = CONV_FORMATS.every(([k]) => selected[k]);
			const toggle = (k) => setSelected((s) => ({ ...s, [k]: !s[k] }));
			const setAll = (v) => setSelected({ md: v, txt: v, html: v, json: v, jsonl: v, openai: v });
			const start = () => { if (!busy && sessionId !== void 0) setPhase("pick"); };
			const close = () => { if (!busy) setPhase("idle"); };
			const run = () => {
				if (busy || pickedCount === 0) return;
				setPhase("busy");
				const kinds = CONV_FORMATS.filter(([k]) => selected[k]).map(([k]) => k);
				exportConversation(sessionId, kinds, contentOpts).then((summary) => {
					setPhase("ok");
					setDetail("已生成 " + summary.files + " 个文件（" + summary.sessions + " 个会话" + (summary.broken > 0 ? "，" + summary.broken + " 行损坏已跳过" : "") + "），下载已开始。");
				}).catch((error) => {
					setPhase("error");
					setDetail(error instanceof Error ? error.message : String(error));
				});
			};
			const titles = { pick: "导出对话", busy: "正在导出对话…", ok: "导出完成", error: "导出失败" };
			const picker = phase === "pick" ? react_jsx_runtime.jsxs("div", { className: "dshCvtForm", children: [
				react_jsx_runtime.jsx("div", { className: "dshCvtHint", children: "选择要导出的格式（可多选）：" }),
				react_jsx_runtime.jsx("div", { className: "dshCvtGrid", children: CONV_FORMATS.map(([k, label, ext]) => react_jsx_runtime.jsxs("label", { className: "dshCvtOpt", children: [
					react_jsx_runtime.jsx("input", { type: "checkbox", checked: selected[k], onChange: () => toggle(k) }),
					react_jsx_runtime.jsx("span", { children: label }),
					react_jsx_runtime.jsx("code", { children: ext })
				] }, k)) }),
				react_jsx_runtime.jsx("div", { className: "dshCvtHint", children: "导出内容（可选）：" }),
				react_jsx_runtime.jsx("div", { className: "dshCvtGrid", children: [
					react_jsx_runtime.jsxs("label", { className: "dshCvtOpt", children: [
						react_jsx_runtime.jsx("input", { type: "checkbox", checked: contentOpts.reasoning, onChange: () => setContentOpts((s) => ({ ...s, reasoning: !s.reasoning })) }),
						react_jsx_runtime.jsx("span", { children: "包含推理过程 💭" })
					] }),
					react_jsx_runtime.jsxs("label", { className: "dshCvtOpt", children: [
						react_jsx_runtime.jsx("input", { type: "checkbox", checked: contentOpts.tools, onChange: () => setContentOpts((s) => ({ ...s, tools: !s.tools })) }),
						react_jsx_runtime.jsx("span", { children: "包含工具调用与结果 🔧" })
					] })
				] }),
				react_jsx_runtime.jsx("div", { className: "dshCvtActions", children: [
					react_jsx_runtime.jsx(_primitives.Button, { size: "sm", onClick: () => setAll(!allOn), children: allOn ? "全不选" : "全选" }),
					react_jsx_runtime.jsx(_primitives.Button, { size: "sm", onClick: close, children: "取消" }),
					react_jsx_runtime.jsx(_primitives.Button, { size: "sm", variant: "primary", disabled: pickedCount === 0, onClick: run, children: pickedCount === 0 ? "导出" : "导出（" + pickedCount + " 项）" })
				] })
			] }) : null;
			return react_jsx_runtime.jsxs(react.Fragment, { children: [
				react_jsx_runtime.jsx("button", {
					type: "button",
					className: "dshCvtButton",
					disabled: busy,
					"aria-busy": busy,
					title: "Export this session as a conversation (pick formats)",
					onClick: start,
					children: [react_jsx_runtime.jsx("span", { children: busy ? "导出中…" : "Export chat" }), react_jsx_runtime.jsx(_primitives.IconDownloadOutline16, { size: 12 })]
				}),
				react_jsx_runtime.jsx(_primitives.Modal, {
					open,
					onClose: close,
					title: titles[phase] ?? "导出对话",
					description: phase === "busy" ? "正在准备会话日志并转换…" : phase === "ok" || phase === "error" ? detail : "",
					closeLabel: "关闭",
					children: picker,
					footer: phase === "ok" || phase === "error" ? react_jsx_runtime.jsx(_primitives.Button, { variant: "primary", onClick: close, children: "关闭" }) : void 0
				})
			] });
		}

		// 按钮与导出表单样式（按钮与 Session log 一致：白底描边胶囊）
		const css = ".dshCvtButton{border:1px solid var(--dsw-alias-border-l2);min-width:111px;height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:18px;justify-content:center;align-items:center;gap:4px;padding:6px 12px;font-size:13px;font-weight:400;line-height:20px;display:inline-flex}.dshCvtButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dshCvtButton:disabled{color:var(--dsw-alias-label-dimmed);cursor:wait}.dshCvtButton span,.dshCvtButton svg{flex:none}.dshCvtButton span{white-space:nowrap}.dshCvtForm{display:flex;flex-direction:column;gap:12px}.dshCvtHint{color:var(--dsw-alias-label-secondary);font-size:13px}.dshCvtGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.dshCvtOpt{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;cursor:pointer;font-size:13px;background:var(--dsw-alias-bg-layer-2);transition:border-color .12s}.dshCvtOpt:hover{border-color:var(--dsw-alias-label-dimmed)}.dshCvtOpt input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none}.dshCvtOpt span{flex:1;color:var(--dsw-alias-label-primary)}.dshCvtOpt code{color:var(--dsw-alias-label-tertiary);font:12px ui-monospace,Consolas,monospace}.dshCvtActions{display:flex;justify-content:flex-end;gap:8px}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify("@deepseek-ai/dsh-session-conversation-export/button.css") + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-session-conversation-export";
			tag.dataset.pluginCss = "@deepseek-ai/dsh-session-conversation-export/button.css";
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region 插件装配
		/**
		* 挂载浏览器插件：向 conversation.session.header.utilities 注入"导出对话"按钮，
		* order:-1 使其排在 Session log（order 默认 0）左侧。
		*/
		const apply = (ctx) => {
			ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "session-conversation-export",
				order: -1,
				label: "Export chat"
			}, ConversationExportButton)), "session-conversation-export: header action");
		};
		exports.apply = apply;
		exports.inject = ["slots"];
		//#endregion
		return module.exports;
	}
});
`;

const client = clientTemplate.replace('__CORE__', () => core);

// ---------- 5. 写盘 ----------
fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(OUT, 'lib', 'index.js'), host, 'utf8');
fs.writeFileSync(path.join(OUT, 'lib', 'client.js'), client, 'utf8');
fs.writeFileSync(path.join(OUT, 'cordis.patch.yml'), bundlePatch, 'utf8');

console.log('✔ 已生成插件包:');
for (const f of ['package.json', 'lib/index.js', 'lib/client.js']) {
  const p = path.join(OUT, f);
  console.log(`  ${p} (${fs.statSync(p).size} B)`);
}
