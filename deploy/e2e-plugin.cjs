// End-to-end: simulate the plugin button flow against the LIVE export payload.
// Requires a running DSH web server and DSH_SESSION_ID in the environment.
// Usage: node deploy/e2e-plugin.cjs   (from the package root)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const gui = fs.readFileSync(path.join(__dirname, '..', 'session-conversation-gui.html'), 'utf8');
const coreSrc = gui.match(/<script id="core-logic">([\s\S]*?)<\/script>/)[1];

const sandbox = { window: {}, TextDecoder, TextEncoder, DecompressionStream, Blob, Response, URL, console };
vm.createContext(sandbox);
vm.runInContext(coreSrc, sandbox, { filename: 'core.js' });
const core = sandbox.window.__dshConvCore;
if (!core) { console.error('核心未导出'); process.exit(1); }

(async () => {
  const sessionId = process.env.DSH_SESSION_ID;
  const res = await fetch(`http://127.0.0.1:3080/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`);
  if (!res.ok) { console.error('导出 HTTP', res.status); process.exit(1); }
  const buf = await res.arrayBuffer();
  const entries = await core.readZipEntries(buf);
  const jsonls = entries.filter((e) => /\.jsonl(\.zstd)?$/i.test(e.name));
  console.log('✔ ZIP 条目:', entries.length, '| 匹配 jsonl:', jsonls.length, jsonls.map((e) => e.name).join(', '));

  const opts = { keepPlugin: false, reasoning: true, tools: true, maxToolResult: 2000 };
  const convs = [];
  let broken = 0;
  for (const entry of jsonls) {
    const parsed = core.parseEvents(new TextDecoder().decode(entry.data));
    broken += parsed.broken;
    const conv = core.buildConversation(parsed.events, opts);
    conv.meta.sourceFile = entry.name;
    if (!conv.meta.title) conv.meta.title = conv.meta.sessionId ? '会话 ' + conv.meta.sessionId.slice(0, 8) : '(未命名会话)';
    convs.push(conv);
    console.log(`  ✔ ${entry.name}: 标题「${conv.meta.title}」消息 ${conv.stats.messages} 工具 ${conv.stats.toolCalls} 损坏行 ${parsed.broken}`);
  }
  const kinds = [['md', core.renderMarkdown], ['txt', core.renderPlainText], ['html', core.renderHtmlPage], ['json', core.renderJson], ['jsonl', core.renderJsonl], ['openai', core.renderOpenAI]];
  const files = [];
  for (const conv of convs) {
    for (const [kind, render] of kinds) files.push({ name: `${core.safeName(conv.meta.title)}.conversation.${kind}`, data: new TextEncoder().encode(render(conv, opts)) });
  }
  const zipBlob = core.makeStoreZip(files);
  const ab = await zipBlob.arrayBuffer();
  console.log('✔ 生成文件:', files.length, '| 打包 ZIP:', ab.byteLength, 'bytes');
  const rt = await core.readZipEntries(ab);
  console.log('✔ 回读 ZIP 条目:', rt.length, '| 首条:', rt[0].name, `(${rt[0].data.length}B)`);
  console.log('端到端全部通过 ✔');
})().catch((err) => { console.error('失败:', err.message); process.exit(1); });
