// Functional test: run the REAL bundle's exportConversation with kind selection,
// against the live export payload (single format → direct file; multiple → ZIP).
// Requires a running DSH web server and DSH_SESSION_ID in the environment
// (e.g. run from within a DSH agent session, as here).
// Usage: node deploy/test-picker.cjs   (from the package root)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BUNDLE = path.join(__dirname, '..', 'plugin', '@deepseek-ai', 'dsh-session-conversation-export', 'lib', 'client.js');
let bundle = fs.readFileSync(BUNDLE, 'utf8');
// 在 factory 返回前注入测试句柄
bundle = bundle.replace('return module.exports;', 'exports.__test = { exportConversation: exportConversation, CONV_FORMATS: CONV_FORMATS, CONV_KIND_MAP: CONV_KIND_MAP }; return module.exports;');

let captured = null;
const downloads = [];
const sandbox = {
  window: { __ModuleLoader__: { load(rec) { captured = rec; } } },
  document: {
    createElement: (tag) => ({ tag, dataset: {}, download: '', href: '', click() { downloads.push({ name: this.download, href: this.href }); }, remove() {} }),
    body: { appendChild: () => {} },
    head: { appendChild: () => {} },
    querySelector: () => null,
  },
  URL,
  TextDecoder, TextEncoder, DecompressionStream, Blob, Response,
  fetch: (u) => fetch(u), // 真实 fetch 打线上导出
  console,
  setTimeout,
  location: { origin: 'http://127.0.0.1:3080' },
};
sandbox.URL.createObjectURL = () => 'blob:fake';
sandbox.URL.revokeObjectURL = () => {};
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: 'bundle.js' });

const primitives = { Modal: () => null, Button: () => null, IconDownloadOutline16: () => null };
const react = { useState: () => ['idle', () => {}] };
const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };
const requireStub = (id) => {
  if (id === 'react') return react;
  if (id === 'react/jsx-runtime') return jsxRuntime;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error('unexpected require: ' + id);
};
captured.factory(requireStub);
const t = captured.factory(requireStub).__test;
if (!t) { console.error('✘ 测试句柄缺失'); process.exit(1); }

const sessionId = process.env.DSH_SESSION_ID;
let failures = 0;
const check = (name, cond, extra) => { console.log(`${cond ? '✔' : '✘'} ${name}${extra ? ' — ' + extra : ''}`); if (!cond) failures++; };

(async () => {
  // 1) 单选 Markdown → 直接下载单个 .md 文件
  downloads.length = 0;
  const r1 = await t.exportConversation(sessionId, ['md']);
  check('单选 md → 1 个文件', r1.files === 1, `files=${r1.files}`);
  check('单选 md → 直接下载 .md', downloads.length === 1 && downloads[0].name.endsWith('.conversation.md'), downloads[0]?.name);
  check('单选 md → 不打包 ZIP', !downloads[0]?.name.endsWith('.zip'));

  // 2) 多选 md+json+openai → 打包 ZIP（3 个文件）
  downloads.length = 0;
  const r2 = await t.exportConversation(sessionId, ['md', 'json', 'openai']);
  check('多选 3 项 → 3 个文件', r2.files === 3, `files=${r2.files}`);
  check('多选 3 项 → 下载 ZIP', downloads.length === 1 && downloads[0].name.endsWith('.conversation.zip'), downloads[0]?.name);
  check('含子会话统计', r2.sessions >= 1, `sessions=${r2.sessions}`);

  // 3) 未知格式键 → 0 文件、不下载
  downloads.length = 0;
  const r3 = await t.exportConversation(sessionId, ['bogus']);
  check('未知格式 → 0 文件且不下载', r3.files === 0 && downloads.length === 0, `files=${r3.files}, dl=${downloads.length}`);

  // 4) 全选 → 6 个文件打包
  downloads.length = 0;
  const r4 = await t.exportConversation(sessionId, t.CONV_FORMATS.map(([k]) => k));
  check('全选 6 项 → 6 个文件 + ZIP', r4.files === 6 && downloads.length === 1 && downloads[0].name.endsWith('.zip'), `files=${r4.files}`);

  console.log(failures === 0 ? '\n导出选择逻辑全部通过 ✔' : `\n${failures} 项失败 ✘`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error('失败:', err); process.exit(1); });
