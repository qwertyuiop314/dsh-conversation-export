// Portable regression test for the shared core logic (browser GUI core).
// Runs offline against samples/session.jsonl; no DSH server required.
// Usage: node scripts/test-gui-core.cjs   (from the package root)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const GUI = path.join(ROOT, 'session-conversation-gui.html');
const SAMPLE = path.join(ROOT, 'samples', 'session.jsonl');
const CLI = path.join(ROOT, 'session-to-conversation.cjs');

const html = fs.readFileSync(GUI, 'utf8');
const m = html.match(/<script id="core-logic">([\s\S]*?)<\/script>/);
if (!m) { console.error('core-logic script not found in GUI'); process.exit(1); }

const sandbox = {
  window: {},
  TextDecoder, TextEncoder, DecompressionStream, Blob, Response,
  console, setTimeout, clearTimeout,
};
vm.createContext(sandbox);
vm.runInContext(m[1], sandbox, { filename: 'core-logic.js' });
const core = sandbox.window.__dshConvCore;
if (!core) { console.error('__dshConvCore missing'); process.exit(1); }

let failures = 0;
const check = (name, cond, extra) => {
  console.log(`${cond ? '✔' : '✘'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

(async () => {
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const { events, broken } = core.parseEvents(text);
  check('parseEvents 无损', broken === 0, `broken=${broken}, events=${events.length}`);

  const opts = { keepPlugin: false, reasoning: true, tools: true, maxToolResult: 2000 };
  const conv = core.buildConversation(events, opts);
  check('消息=3（1用户+2助手）', conv.messages.length === 3, `got ${conv.messages.length}`);
  check('用户消息=1', conv.stats.userMessages === 1);
  check('助手消息=2', conv.stats.assistantMessages === 2);
  check('工具调用=1', conv.stats.toolCalls === 1);
  check('过滤插件消息=1', conv.stats.droppedPlugin === 1);
  check('标题正确', conv.meta.title === '示例会话：创建文件', conv.meta.title);
  check('模型正确', conv.meta.model === 'deepseek-v4-flash', conv.meta.model);

  const tr = conv.messages[1].content.find((b) => b.type === 'tool-result');
  check('工具结果内容非空', tr && tr.content.length > 0 && tr.content[0].text.includes('hello.txt'));

  // 六种渲染器
  const md = core.renderMarkdown(conv, opts);
  check('renderMarkdown 非空', md.length > 100 && md.includes('💭 推理过程') && md.includes('📥 工具结果'));
  check('renderPlainText 非空', core.renderPlainText(conv, opts).includes('[用户]'));
  const htmlPage = core.renderHtmlPage(conv, opts);
  check('renderHtmlPage 含 details', htmlPage.includes('<details>') && htmlPage.startsWith('<!DOCTYPE html>'));
  check('HTML 已渲染 Markdown（<h2>）', htmlPage.includes('<h2>'));
  JSON.parse(core.renderJson(conv, opts));
  check('renderJson 可解析', true);
  check('renderJsonl 行数=3', core.renderJsonl(conv, opts).trim().split('\n').length === 3);
  const oai = JSON.parse(core.renderOpenAI(conv, opts));
  check('OpenAI tool 消息=1', oai.messages.filter((x) => x.role === 'tool').length === 1);
  check('OpenAI reasoning_content 存在', oai.messages.some((x) => x.reasoning_content));
  check('OpenAI tool_calls 存在', oai.messages.some((x) => x.tool_calls));

  // 选项裁剪
  const noOpts = { keepPlugin: false, reasoning: false, tools: false, maxToolResult: 2000 };
  const md2 = core.renderMarkdown(core.buildConversation(events, noOpts), noOpts);
  check('--no-reasoning/tools: 无推理块', !md2.includes('推理过程'));
  check('--no-reasoning/tools: 无工具结果', !md2.includes('工具结果'));

  // ZIP round-trip（STORE）
  const files = [{ name: 'a.jsonl', data: new TextEncoder().encode('{"type":"session"}\n') }];
  const zipBlob = core.makeStoreZip(files);
  const entries = await core.readZipEntries(await zipBlob.arrayBuffer());
  check('ZIP round-trip', entries.length === 1 && entries[0].name === 'a.jsonl');

  // Markdown → HTML
  const mdTests = [
    ['标题', '# 你好\n## 二级', '<h1>你好</h1>\n<h2>二级</h2>'],
    ['加粗斜体', '**粗** 和 *斜* 和 ~~删~~', '<p><strong>粗</strong> 和 <em>斜</em> 和 <del>删</del></p>'],
    ['代码块', '```js\nconst a = 1;\n```', '<pre><code class="language-js">const a = 1;</code></pre>'],
    ['列表', '- 苹果\n- 香蕉', '<ul><li>苹果</li><li>香蕉</li></ul>'],
    ['嵌套列表', '- 外层\n  - 内层', '<ul><li>外层<ul><li>内层</li></ul></li></ul>'],
    ['表格', '| a | b |\n|---|---|\n| 1 | 2 |', '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'],
    ['XSS-脚本', '<script>alert(1)</script>', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
    ['XSS-危险链接', '[点我](javascript:alert(1))', '<p>点我</p>'],
  ];
  for (const [name, src, expect] of mdTests) {
    const got = core.renderMarkdownHtml(src);
    check(`Markdown-${name}`, got === expect, `got: ${got.slice(0, 80)}`);
  }

  // 与 CLI 版一致性
  const cjs = require(CLI);
  const convCjs = cjs.buildConversation(cjs.parseEvents(text).events, opts);
  const mdCjs = cjs.renderMarkdown(convCjs, opts);
  check('与 CLI 版 Markdown 输出一致', md === mdCjs, `gui=${md.length}B cjs=${mdCjs.length}B`);

  console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
