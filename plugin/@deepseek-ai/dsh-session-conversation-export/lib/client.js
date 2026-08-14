window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-session-conversation-export",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region 核心逻辑（与 session-to-conversation.cjs / GUI 完全一致）

/* ==================================================================
 * 核心逻辑（纯函数，无 DOM 依赖）—— 与 session-to-conversation.cjs 一致
 * ================================================================== */

const escHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function fmtTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { iso: d.toISOString(), local };
}

function truncateText(text, max) {
  if (max === 0 || text == null) return text == null ? '' : String(text);
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max)}\n… [已截断，共 ${s.length} 字符]`;
}

function tryParseArgs(raw) {
  if (typeof raw !== 'string') return { ok: false, value: raw };
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch { return { ok: false, value: raw }; }
}

function blocksToText(blocks) {
  return (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function safeName(s) {
  return String(s).replace(/[^\w\u4e00-\u9fff-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'session';
}

/* ---------------- ZIP 读取（浏览器版：STORE / DEFLATE-raw） ---------------- */

async function readZipEntries(buf) {
  const view = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到 EOCD）');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const entries = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  const decoder = new TextDecoder();
  while (p + 46 <= end && view.getUint32(p, true) === 0x02014b50) {
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(buf, p + 46, nameLen));
    entries.push({ name, method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const out = [];
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    const lp = e.localOffset;
    const nLen = view.getUint16(lp + 26, true);
    const xLen = view.getUint16(lp + 28, true);
    const dataStart = lp + 30 + nLen + xLen;
    const compressed = new Uint8Array(buf, dataStart, e.compSize);
    let data;
    if (e.method === 0) data = compressed;
    else if (e.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('当前浏览器不支持 ZIP 解压（缺少 DecompressionStream），请改用 Chrome/Edge/Firefox/Safari 较新版本，或直接使用 .jsonl 文件');
      }
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compressed]).stream().pipeThrough(ds);
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error(`ZIP 条目不支持压缩方式: ${e.method}（${e.name}）`);
    }
    out.push({ name: e.name, data });
  }
  return out;
}

/* ---------------- 事件解析（容错） ---------------- */

function parseEvents(text) {
  const events = [];
  let broken = 0;
  let brokenSample = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.type === 'string') events.push(e);
      else { broken++; if (!brokenSample) brokenSample = `第 ${i + 1} 行缺少 type 字段`; }
    } catch {
      broken++;
      if (!brokenSample) brokenSample = `第 ${i + 1} 行 JSON 解析失败`;
    }
  }
  events.sort((a, b) => {
    const sa = a.seq !== undefined ? a.seq : a.seq0;
    const sb = b.seq !== undefined ? b.seq : b.seq0;
    return (sa ?? 0) - (sb ?? 0);
  });
  return { events, broken, brokenSample };
}

/* ---------------- 对话重建（清洗核心） ---------------- */

function buildConversation(rawEvents, opts) {
  const meta = {
    sessionId: null, title: null, createdAt: null, cwd: null,
    delegationDepth: null, agentPreset: null, model: null, provider: null,
    systemPrompt: null, sourceFile: null,
  };
  const messages = [];
  let currentTurn = null;
  let currentStep = null;
  let droppedPlugin = 0;
  let droppedDup = 0;

  const toolResults = [];
  for (const e of rawEvents) {
    if (e.type === 'tool/result') {
      const blocks = e.data?.message?.content || [];
      toolResults.push({
        callId: e.data?.message?.source?.callId,
        blocks,
        isError: blocks.some((b) => b.isError) || e.data?.message?.content?.some((b) => b.isError === true),
        time: e.time,
      });
    }
  }

  for (const e of rawEvents) {
    switch (e.type) {
      case 'session': {
        meta.sessionId = e.id;
        meta.createdAt = fmtTime(e.createdAt);
        meta.cwd = e.cwd;
        meta.delegationDepth = e.delegationDepth;
        meta.agentPreset = e.agentPreset;
        break;
      }
      case 'session/title': {
        if (e.data?.title) meta.title = e.data.title;
        break;
      }
      case 'request/header': {
        const cfg = e.data?.header?.config || {};
        if (cfg.model) meta.model = cfg.model;
        if (cfg.provider) meta.provider = cfg.provider;
        const sys = e.data?.header?.system;
        if (typeof sys === 'string') meta.systemPrompt = sys;
        break;
      }
      case 'turn/start': { currentTurn = e.data?.turn ?? currentTurn; break; }
      case 'turn/end': { currentTurn = null; break; }
      case 'step/start': { currentStep = e.data?.step ?? currentStep; break; }
      case 'step/end': { currentStep = null; break; }

      case 'user/message': {
        const d = e.data || {};
        const kind = d.source?.kind || 'unknown';
        const injected = kind !== 'user' && kind !== 'tool';
        if (injected && !opts.keepPlugin) { droppedPlugin++; break; }
        const msg = {
          role: 'user', id: d.id || null, time: fmtTime(e.time),
          turn: currentTurn, step: currentStep, kind,
          source: d.source || null,
          content: normalizeContentBlocks(d.content || []),
        };
        pushMessage(messages, msg, () => { droppedDup++; });
        break;
      }

      case 'assistant/message': {
        const d = e.data || {};
        const m = d.message || {};
        const msg = {
          role: 'assistant', id: m.id || null, time: fmtTime(e.time),
          turn: d.turn ?? currentTurn, step: d.step ?? currentStep, kind: 'model',
          source: m.source || null,
          content: normalizeContentBlocks(m.content || []),
          usage: d.usage || null,
        };
        if (msg.source?.model) meta.model = msg.source.model;
        if (msg.source?.provider) meta.provider = msg.source.provider;
        pushMessage(messages, msg, () => { droppedDup++; });
        break;
      }
      default: break;
    }
  }

  for (const tr of toolResults) {
    const target = findAssistantWithCall(messages, tr.callId);
    const normalized = normalizeContentBlocks(tr.blocks);
    let inner = normalized;
    if (normalized.length === 1 && normalized[0]?.type === 'tool-result' && Array.isArray(normalized[0].content)) {
      inner = normalized[0].content;
    }
    const block = {
      type: 'tool-result', toolCallId: tr.callId, isError: !!tr.isError,
      time: fmtTime(tr.time), content: inner,
    };
    if (target) target.content.push(block);
    else {
      pushMessage(messages, {
        role: 'user', id: null, time: tr.time ? fmtTime(tr.time) : null,
        turn: null, step: null, kind: 'tool-result', source: { kind: 'tool' },
        content: [block],
      }, () => {});
    }
  }

  for (const m of messages) {
    m.content = m.content.filter((b) => {
      if (b.type === 'reasoning' && !opts.reasoning) return false;
      if (b.type === 'tool-call' && !opts.tools) return false;
      if (b.type === 'tool-result' && !opts.tools) return false;
      return true;
    });
    for (const b of m.content) {
      if (b.type === 'tool-call') b.argumentsParsed = tryParseArgs(b.arguments);
    }
  }

  const stats = {
    messages: messages.length,
    userMessages: messages.filter((m) => m.role === 'user' && m.kind !== 'tool-result').length,
    assistantMessages: messages.filter((m) => m.role === 'assistant').length,
    toolCalls: messages.reduce((n, m) => n + m.content.filter((b) => b.type === 'tool-call').length, 0),
    toolResults: messages.reduce((n, m) => n + m.content.filter((b) => b.type === 'tool-result').length, 0),
    reasoningBlocks: messages.reduce((n, m) => n + m.content.filter((b) => b.type === 'reasoning').length, 0),
    turns: new Set(messages.map((m) => m.turn).filter((t) => t != null)).size,
    droppedPlugin, droppedDup,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
  };
  for (const m of messages) {
    if (m.usage) {
      stats.inputTokens += m.usage.inputTokens || 0;
      stats.outputTokens += m.usage.outputTokens || 0;
      stats.cacheReadTokens += m.usage.cacheReadTokens || 0;
      stats.reasoningTokens += m.usage.reasoningTokens || 0;
    }
  }
  return { meta, messages, stats };
}

function normalizeContentBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' || b.type === 'reasoning') {
      if (typeof b.text === 'string' && b.text) out.push({ type: b.type, text: b.text });
    } else if (b.type === 'tool-call') {
      out.push({ type: 'tool-call', id: b.id, name: b.name, arguments: b.arguments ?? '' });
    } else if (b.type === 'tool-result') {
      out.push({
        type: 'tool-result', toolCallId: b.toolCallId, isError: !!b.isError,
        content: normalizeContentBlocks(b.content),
      });
    } else {
      out.push({ type: b.type || 'unknown', ...b });
    }
  }
  return out;
}

function pushMessage(messages, msg, onDup) {
  const last = messages[messages.length - 1];
  if (last && last.role === msg.role) {
    const same = last.content.length === msg.content.length &&
      last.content.every((b, i) => {
        const o = msg.content[i];
        return b.type === o.type && (b.text === o.text) && (b.name === o.name) && (b.id === o.id) && (b.arguments === o.arguments);
      });
    if (same) { onDup(); return; }
  }
  messages.push(msg);
}

function findAssistantWithCall(messages, callId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (m.content.some((b) => b.type === 'tool-call' && b.id === callId)) return m;
  }
  return null;
}

function toolResultText(block, opts) {
  return truncateText((block.content || []).map((b) => b.text || '').join('\n'), opts.maxToolResult);
}

function convHeaderLines(conv, opts) {
  const { meta, stats } = conv;
  const lines = [];
  lines.push(`# ${meta.title || '(未命名会话)'}`);
  lines.push('');
  lines.push(`- Session: \`${meta.sessionId || '-'}\``);
  lines.push(`- 创建时间: ${meta.createdAt ? meta.createdAt.local : '-'}`);
  if (meta.model) lines.push(`- 模型: ${meta.provider ? `${meta.provider} / ` : ''}${meta.model}`);
  if (meta.cwd) lines.push(`- 工作目录: \`${meta.cwd}\``);
  if (meta.agentPreset) lines.push(`- Agent 预设: \`${meta.agentPreset}\``);
  lines.push(`- 消息数: ${stats.messages}（用户 ${stats.userMessages} / 助手 ${stats.assistantMessages}），回合: ${stats.turns}，工具调用: ${stats.toolCalls}`);
  if (stats.inputTokens + stats.outputTokens > 0) {
    lines.push(`- Token: 输入 ${stats.inputTokens} + 缓存读 ${stats.cacheReadTokens} / 输出 ${stats.outputTokens}（其中推理 ${stats.reasoningTokens}）`);
  }
  if (stats.droppedPlugin > 0) lines.push(`- 已过滤插件注入消息: ${stats.droppedPlugin} 条`);
  if (stats.droppedDup > 0) lines.push(`- 已去重重复消息: ${stats.droppedDup} 条`);
  lines.push('');
  return lines;
}

/* ---------------- 渲染器 ---------------- */

function renderMarkdown(conv, opts) {
  const out = convHeaderLines(conv, opts);
  let idx = 0;
  for (const m of conv.messages) {
    idx++;
    const who = m.role === 'user' ? '👤 用户' : '🤖 助手';
    const turn = m.turn != null ? ` 回合 ${m.turn}` : '';
    const step = m.step != null ? ` 步骤 ${m.step}` : '';
    const time = m.time ? ` · ${m.time.local}` : '';
    out.push(`### ${idx}. ${who}${turn}${step}${time}`);
    out.push('');
    for (const b of m.content) {
      if (b.type === 'text') { out.push(b.text); out.push(''); }
      else if (b.type === 'reasoning') {
        out.push('<details>', '<summary>💭 推理过程</summary>', '', b.text, '', '</details>', '');
      } else if (b.type === 'tool-call') {
        out.push('<details>', `<summary>🔧 工具调用: <code>${b.name}</code>${b.id ? `（${b.id}）` : ''}</summary>`, '',
          '```json', b.argumentsParsed?.ok ? JSON.stringify(b.argumentsParsed.value, null, 2) : b.arguments, '```', '',
          '</details>', '');
      } else if (b.type === 'tool-result') {
        out.push('<details>', `<summary>📥 工具结果${b.isError ? '（错误）' : ''}: <code>${b.toolCallId || ''}</code></summary>`, '',
          '```text', toolResultText(b, opts), '```', '', '</details>', '');
      }
    }
  }
  return out.join('\n') + '\n';
}

function renderPlainText(conv, opts) {
  const out = [];
  out.push(conv.meta.title || '(未命名会话)');
  out.push('='.repeat(40));
  out.push(`Session: ${conv.meta.sessionId || '-'}`);
  out.push(`创建时间: ${conv.meta.createdAt ? conv.meta.createdAt.local : '-'}`);
  if (conv.meta.model) out.push(`模型: ${conv.meta.model}`);
  if (conv.meta.cwd) out.push(`工作目录: ${conv.meta.cwd}`);
  out.push('');
  let idx = 0;
  for (const m of conv.messages) {
    idx++;
    const who = m.role === 'user' ? '[用户]' : '[助手]';
    const pos = m.turn != null ? ` (回合${m.turn}` + (m.step != null ? ` 步骤${m.step}` : '') + ')' : '';
    out.push(`${who}${pos}`);
    for (const b of m.content) {
      if (b.type === 'text') out.push(b.text);
      else if (b.type === 'reasoning') out.push('--- 推理过程 ---', b.text, '--- 推理结束 ---');
      else if (b.type === 'tool-call') {
        out.push(`--- 工具调用: ${b.name} (${b.id || ''}) ---`);
        out.push(b.argumentsParsed?.ok ? JSON.stringify(b.argumentsParsed.value, null, 2) : b.arguments);
        out.push('--- 工具调用结束 ---');
      } else if (b.type === 'tool-result') {
        out.push(`--- 工具结果${b.isError ? '（错误）' : ''}: ${b.toolCallId || ''} ---`);
        out.push(toolResultText(b, opts));
        out.push('--- 工具结果结束 ---');
      }
    }
    out.push('');
  }
  return out.join('\n') + '\n';
}

/* ---------------- Markdown → HTML（零依赖，GFM 常用子集） ---------------- */

function mdSafeUrl(u) {
  const s = String(u).trim();
  if (s === '') return false;
  if (/^(javascript|data|vbscript):/i.test(s)) return false;
  return true;
}

/** 行内 Markdown：先转义 HTML 再做行内变换（code/图片/链接/加粗/斜体/删除线）。 */
function mdInline(text) {
  let t = escHtml(String(text));
  const tokens = [];
  // 先保护行内代码，避免后续变换影响 code 内容
  t = t.replace(/`([^`\n]+)`/g, (m, c) => {
    tokens.push('<code>' + c + '</code>');
    return '\u0000MD' + (tokens.length - 1) + '\u0000';
  });
  // 图片 ![alt](url)
  t = t.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()]*\))*)(?:\s+"[^"]*")?\)/g, (m, alt, url) =>
    mdSafeUrl(url) ? '<img src="' + escHtml(url) + '" alt="' + escHtml(alt) + '" loading="lazy">' : m);
  // 链接 [text](url)
  t = t.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))*)(?:\s+"[^"]*")?\)/g, (m, text, url) =>
    mdSafeUrl(url) ? '<a href="' + escHtml(url) + '" target="_blank" rel="noreferrer">' + text + '</a>' : text);
  // 加粗
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  // 斜体（避免与已替换的加粗冲突）
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  // 删除线
  t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // 还原受保护的代码
  t = t.replace(/\u0000MD(\d+)\u0000/g, (m, i) => tokens[Number(i)]);
  return t;
}

/** 渲染列表块（支持缩进嵌套）。返回 {html, next}。 */
function mdRenderList(lines, start) {
  const baseIndent = lines[start].match(/^(\s*)/)[1].length;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (!m || m[1].length > baseIndent) break;
    const ordered = /^\d/.test(m[2]);
    let text = m[3];
    i++;
    // 续行（缩进更深且不是列表项）
    while (i < lines.length) {
      const cont = lines[i].match(/^(\s*)(\S.*)$/);
      if (!cont || cont[1].length <= baseIndent) break;
      if (/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) break;
      text += '\n' + cont[2];
      i++;
    }
    // 子列表（更深缩进的列表项）
    let children = '';
    if (i < lines.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]) && lines[i].match(/^(\s*)/)[1].length > baseIndent) {
      const sub = mdRenderList(lines, i);
      children = sub.html;
      i = sub.next;
    }
    items.push({ ordered, text, children });
  }
  const tag = items[0]?.ordered ? 'ol' : 'ul';
  const html = '<' + tag + '>' + items.map((it) =>
    '<li>' + mdInline(it.text).replace(/\n/g, '<br>') + it.children + '</li>'
  ).join('') + '</' + tag + '>';
  return { html, next: i };
}

/** GFM 管道表格。返回 {html, next} 或 null。 */
function mdTryTable(lines, i) {
  const header = lines[i];
  const sep = lines[i + 1];
  if (!sep) return null;
  if (!/^\s*\|.*\|\s*$/.test(header)) return null;
  if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(sep) || !/-/.test(sep)) return null;
  const splitRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const headers = splitRow(header);
  const aligns = splitRow(sep).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null);
  const rows = [];
  let j = i + 2;
  while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { rows.push(splitRow(lines[j])); j++; }
  const cell = (content, align) => (align ? ' style="text-align:' + align + '"' : '') + '>' + mdInline(content);
  let html = '<table><thead><tr>' + headers.map((h, k) => '<th' + cell(h, aligns[k]) + '</th>').join('') + '</tr></thead><tbody>';
  html += rows.map((r) => '<tr>' + headers.map((_, k) => '<td' + cell(r[k] ?? '', aligns[k]) + '</td>').join('') + '</tr>').join('');
  html += '</tbody></table>';
  return { html, next: j };
}

/** 块级 Markdown → HTML。 */
function renderMarkdownHtml(src) {
  const text = String(src == null ? '' : src).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length === 0) return;
    out.push('<p>' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    // 围栏代码块
    const fence = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      flush();
      const mark = fence[1][0];
      const lang = fence[2].trim();
      const code = [];
      i++;
      while (i < lines.length) {
        if (new RegExp('^' + mark + '{3,}\\s*$').test(lines[i].trim())) { i++; break; }
        code.push(lines[i]);
        i++;
      }
      out.push('<pre><code' + (lang ? ' class="language-' + escHtml(lang) + '"' : '') + '>' + escHtml(code.join('\n')) + '</code></pre>');
      continue;
    }
    // 标题
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const lvl = h[1].length;
      out.push('<h' + lvl + '>' + mdInline(h[2]) + '</h' + lvl + '>');
      i++;
      continue;
    }
    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) { flush(); out.push('<hr>'); i++; continue; }
    // 引用
    if (/^>\s?/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote>' + renderMarkdownHtml(quote.join('\n')) + '</blockquote>');
      continue;
    }
    // 表格
    const tbl = mdTryTable(lines, i);
    if (tbl) { flush(); out.push(tbl.html); i = tbl.next; continue; }
    // 列表
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const list = mdRenderList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }
    // 空行
    if (trimmed === '') { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

function msgBlockHtml(m, opts) {
  const who = m.role === 'user' ? 'user' : 'assistant';
  const label = m.role === 'user' ? '👤 用户' : '🤖 助手';
  const pos = m.turn != null ? ` · 回合 ${m.turn}` + (m.step != null ? ` · 步骤 ${m.step}` : '') : '';
  const time = m.time ? ` · ${m.time.local}` : '';
  let body = '';
  for (const c of m.content) {
    if (c.type === 'text') body += `<div class="text">${renderMarkdownHtml(c.text)}</div>`;
    else if (c.type === 'reasoning') {
      body += `<details><summary>💭 推理过程</summary><pre>${escHtml(c.text)}</pre></details>`;
    } else if (c.type === 'tool-call') {
      const args = c.argumentsParsed?.ok ? JSON.stringify(c.argumentsParsed.value, null, 2) : String(c.arguments ?? '');
      body += `<details><summary>🔧 工具调用: <code>${escHtml(c.name)}</code>${c.id ? ` (${escHtml(c.id)})` : ''}</summary><pre>${escHtml(args)}</pre></details>`;
    } else if (c.type === 'tool-result') {
      const cls = c.isError ? ' err' : '';
      body += `<details><summary>📥 工具结果${c.isError ? '（错误）' : ''}: <code>${escHtml(c.toolCallId || '')}</code></summary><pre class="${cls}">${escHtml(toolResultText(c, opts))}</pre></details>`;
    }
  }
  return `<div class="msg ${who}"><div class="head">${label}${pos}${time}</div>${body}</div>`;
}

function renderHtmlPage(conv, opts) {
  const { meta, stats } = conv;
  const css = `
:root{color-scheme:light dark;--bg:#f7f8fa;--card:#fff;--fg:#1f2328;--muted:#6b7280;--accent:#3b82f6;--border:#e5e7eb;--code:#f3f4f6}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--border:#30363d;--code:#21262d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:28px 0 8px}
.meta{color:var(--muted);font-size:13px;margin-bottom:24px;line-height:1.9}
.msg{border:1px solid var(--border);border-radius:10px;background:var(--card);padding:14px 18px;margin:14px 0}
.msg.user{border-left:4px solid #22c55e}.msg.assistant{border-left:4px solid var(--accent)}
.head{font-weight:600;margin-bottom:8px;color:var(--muted);font-size:13px}
details{border:1px solid var(--border);border-radius:8px;background:var(--code);margin:8px 0;padding:8px 12px}
summary{cursor:pointer;font-size:13px;color:var(--muted);user-select:none}
pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0;font:12.5px/1.6 ui-monospace,Consolas,monospace;overflow:auto;max-height:480px}
code{background:var(--code);border-radius:4px;padding:1px 5px;font:12.5px ui-monospace,Consolas,monospace}
.text{word-break:break-word}
.text p{margin:6px 0}
.text h1,.text h2,.text h3,.text h4,.text h5,.text h6{margin:14px 0 6px;line-height:1.35}
.text h1{font-size:1.5em}.text h2{font-size:1.3em}.text h3{font-size:1.15em}
.text ul,.text ol{margin:6px 0;padding-left:24px}
.text li{margin:2px 0}
.text blockquote{margin:8px 0;padding:2px 14px;border-left:3px solid var(--border);color:var(--muted)}
.text a{color:var(--accent);text-decoration:underline}
.text img{max-width:100%;border-radius:8px}
.text table{border-collapse:collapse;margin:8px 0;max-width:100%;font-size:13px}
.text th,.text td{border:1px solid var(--border);padding:5px 10px}
.text th{background:var(--code)}
.text hr{border:0;border-top:1px solid var(--border);margin:12px 0}
.text del{opacity:.7}
.err{color:#ef4444}.foot{color:var(--muted);font-size:12px;margin-top:32px}
`;
  const statLine = `消息 ${stats.messages} · 回合 ${stats.turns} · 工具调用 ${stats.toolCalls}` +
    (stats.inputTokens + stats.outputTokens > 0 ? ` · Token 输入 ${stats.inputTokens} / 输出 ${stats.outputTokens}` : '') +
    (stats.droppedPlugin > 0 ? ` · 过滤插件消息 ${stats.droppedPlugin}` : '');
  const modelLine = meta.provider ? `${meta.provider} / ${meta.model}` : (meta.model || '-');
  const blocks = conv.messages.map((m) => msgBlockHtml(m, opts)).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(meta.title || '会话记录')} · DSH 对话导出</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
<h1>${escHtml(meta.title || '(未命名会话)')}</h1>
<div class="meta">
Session: <code>${escHtml(meta.sessionId || '-')}</code><br>
创建时间: ${escHtml(meta.createdAt ? meta.createdAt.local : '-')} · 模型: ${escHtml(modelLine)}<br>
${escHtml(statLine)}
</div>
${blocks}
<div class="foot">由 DSH 会话 → 对话记录 生成 · ${new Date().toISOString()}</div>
</div>
</body>
</html>
`;
}

function cleanJsonContent(blocks, opts) {
  return blocks.map((b) => {
    if (b.type === 'text' || b.type === 'reasoning') return { type: b.type, text: b.text };
    if (b.type === 'tool-call') {
      return { type: 'tool-call', id: b.id, name: b.name, arguments: b.argumentsParsed?.ok ? b.argumentsParsed.value : b.arguments };
    }
    if (b.type === 'tool-result') {
      return {
        type: 'tool-result', toolCallId: b.toolCallId, isError: b.isError,
        content: cleanJsonContent(b.content, opts).map((x) => (x.type === 'text' ? { type: 'text', text: truncateText(x.text, opts.maxToolResult) } : x)),
      };
    }
    return b;
  });
}

function renderJson(conv, opts) {
  const out = {
    format: 'dsh-conversation', version: 1,
    meta: {
      sessionId: conv.meta.sessionId, title: conv.meta.title, createdAt: conv.meta.createdAt,
      cwd: conv.meta.cwd, delegationDepth: conv.meta.delegationDepth, agentPreset: conv.meta.agentPreset,
      model: conv.meta.model, provider: conv.meta.provider,
    },
    stats: conv.stats,
    messages: conv.messages.map((m) => ({
      role: m.role, id: m.id, time: m.time, turn: m.turn, step: m.step,
      kind: m.kind, source: m.source, usage: m.usage,
      content: cleanJsonContent(m.content, opts),
    })),
  };
  return JSON.stringify(out, null, 2) + '\n';
}

function renderJsonl(conv, opts) {
  return conv.messages.map((m) => JSON.stringify({
    role: m.role, id: m.id, time: m.time, turn: m.turn, step: m.step,
    kind: m.kind, source: m.source, usage: m.usage,
    content: cleanJsonContent(m.content, opts),
  })).join('\n') + '\n';
}

function renderOpenAI(conv, opts) {
  const messages = [];
  for (const m of conv.messages) {
    if (m.role === 'user' && m.kind === 'tool-result') continue;
    if (m.role === 'user') { messages.push({ role: 'user', content: blocksToText(m.content) }); continue; }
    const text = blocksToText(m.content);
    const reasoning = m.content.find((b) => b.type === 'reasoning')?.text || null;
    const toolCalls = m.content
      .filter((b) => b.type === 'tool-call')
      .map((b) => ({
        id: b.id, type: 'function',
        function: { name: b.name, arguments: b.argumentsParsed?.ok ? JSON.stringify(b.argumentsParsed.value) : String(b.arguments ?? '') },
      }));
    const entry = { role: 'assistant', content: text || null };
    if (reasoning && opts.reasoning) entry.reasoning_content = reasoning;
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    messages.push(entry);
    const results = m.content.filter((b) => b.type === 'tool-result');
    for (const r of results) {
      messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: toolResultText(r, opts) });
    }
  }
  return JSON.stringify({ model: conv.meta.model || null, messages }, null, 2) + '\n';
}

/* ---------------- ZIP 打包（STORE，无需压缩库） ---------------- */

let _crcTable = null;
function crc32(data) {
  if (!_crcTable) {
    _crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = _crcTable[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeStoreZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, f.data);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cd = new DataView(cen.buffer);
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    central.push(cen);
    offset += local.length + f.data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ed = new DataView(eocd.buffer);
  ed.setUint32(0, 0x06054b50, true);
  ed.setUint16(8, files.length, true);
  ed.setUint16(10, files.length, true);
  ed.setUint32(12, centralSize, true);
  ed.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}

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
		async function exportConversation(sessionId, kinds) {
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
			let jsonls = entries.filter((e) => /\.jsonl(\.zstd)?$/i.test(e.name));
			if (jsonls.length === 0) {
				jsonls = [];
				for (const e of entries) {
					const probe = new TextDecoder().decode(e.data.slice(0, 4096));
					if (probe.includes('"type":"session"')) jsonls.push(e);
				}
			}
			if (jsonls.length === 0) throw new Error("导出包中没有找到会话日志（*.jsonl），请确认当前会话有持久化记录");
			const opts = { keepPlugin: false, reasoning: true, tools: true, maxToolResult: 2000 };
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
				exportConversation(sessionId, kinds).then((summary) => {
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
