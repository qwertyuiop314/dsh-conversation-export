// Portable validation of the generated plugin client bundle.
// Runs offline against the GUI core + samples/session.jsonl; no DSH server required.
// Usage: node scripts/validate-plugin.cjs   (from the package root)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'plugin', '@deepseek-ai', 'dsh-session-conversation-export', 'lib', 'client.js');
const GUI = path.join(ROOT, 'session-conversation-gui.html');
const SAMPLE = path.join(ROOT, 'samples', 'session.jsonl');

const bundle = fs.readFileSync(BUNDLE, 'utf8');

let captured = null;
const sandbox = {
  window: { __ModuleLoader__: { load(rec) { captured = rec; } } },
  document: undefined,
  TextDecoder, TextEncoder, DecompressionStream, Blob, Response,
  URL, fetch: undefined,
  console,
};
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: 'plugin-client.js' });

if (!captured) { console.error('✘ loader 未捕获注册'); process.exit(1); }
console.log('✔ 注册 id:', captured.id);

const primitives = { Modal: () => null, Button: () => null, IconDownloadOutline16: () => null };
const react = { useState: () => ['idle', () => {}] };
const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };
const requireStub = (id) => {
  if (id === 'react') return react;
  if (id === 'react/jsx-runtime') return jsxRuntime;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error('unexpected require: ' + id);
};
const exportsObj = captured.factory(requireStub);
if (typeof exportsObj.apply !== 'function') { console.error('✘ apply 缺失'); process.exit(1); }
if (exportsObj.inject === undefined) { console.error('✘ inject 缺失'); process.exit(1); }
console.log('✔ factory 运行 OK · apply:', typeof exportsObj.apply, '· inject:', JSON.stringify(exportsObj.inject));

// 核心逻辑与 GUI 一致
const guiHtml = fs.readFileSync(GUI, 'utf8');
const guiCore = guiHtml.match(/<script id="core-logic">([\s\S]*?)<\/script>/)[1].replace(/\n\/\* 暴露给测试\/外部使用[\s\S]*$/, '');
const bundleCore = bundle.match(/\/\/#region 核心逻辑（[\s\S]*?）\n([\s\S]*?)\n\t\t\/\/#endregion/)[1];
const norm = (s) => s.split('\n').map((l) => l.trimEnd()).join('\n').trim();
console.log('✔ 核心逻辑与 GUI 一致:', norm(bundleCore) === norm(guiCore) ? '是' : '否（不一致！）');
if (norm(bundleCore) !== norm(guiCore)) process.exit(1);

// 导出过滤器正则
const filterLine = bundle.match(/entries\.filter\(\(e\) => ([^;]+)\.test\(e\.name\)/);
if (!filterLine) { console.error('✘ 找不到导出过滤器'); process.exit(1); }
const re = new Function('return ' + filterLine[1])();
const cases = [
  ['session.jsonl', true],
  ['session.jsonl.zstd', true],
  ['subagents/abc/session.jsonl', true],
  ['media/att-123.png', false],
  ['session.jsonl.bak', false],
];
let filterOk = true;
for (const [name, expect] of cases) {
  const got = re.test(name);
  if (got !== expect) filterOk = false;
  console.log(`  ${got === expect ? '✔' : '✘'} 过滤器 ${name} → ${got}（期望 ${expect}）`);
}
if (!filterOk) process.exit(1);

// 真实数据回归（合成示例）
const coreTest = `
const fs = require('fs');
${bundleCore}
const text = fs.readFileSync(${JSON.stringify(SAMPLE)}, 'utf8');
const { events, broken } = parseEvents(text);
const conv = buildConversation(events, { keepPlugin:false, reasoning:true, tools:true, maxToolResult:2000 });
const md = renderMarkdown(conv, { keepPlugin:false, reasoning:true, tools:true, maxToolResult:2000 });
console.log('✔ 示例数据: 消息', conv.messages.length, '| 工具调用', conv.stats.toolCalls, '| 标题', conv.meta.title, '| md', md.length, 'B');
if (conv.messages.length !== 3 || conv.stats.toolCalls !== 1) process.exit(1);
`;
vm.runInNewContext(coreTest, { require, console, TextDecoder, TextEncoder, DecompressionStream, Blob, Response }, { filename: 'core-test.js' });
console.log('全部通过 ✔');
