#!/usr/bin/env node
/**
 * session-to-conversation.cjs
 * ---------------------------------------------------------------------------
 * DSH 会话日志 → 对话记录 转换工具（零依赖，Node.js ≥ 18，仅用内置模块）
 *
 * 背景：DSH 目前只有"导出日志"（/export 下载原始 session ZIP），没有"导出对话"。
 * 本工具把导出的原始日志"洗"一遍，重建为可读、可复用、可分享的对话记录，
 * 并输出多种格式。
 *
 * 输入（--in）：
 *   - 单个 session.jsonl（DSH 原始事件日志，UTF-8，每行一个 JSON 事件）
 *   - 单个 .zip（DSH /export 下载的归档，内含一个或多个 *.jsonl）
 *   - 一个目录（递归扫描其中的 *.jsonl / *.zip）
 *
 * 输出（--out，默认 ./conversation-export）：
 *   每个 session 生成一组文件：.md / .txt / .html / .json / .jsonl / .openai.json
 *   （可用 --formats 选择子集）
 *
 * 清洗规则（"洗一下"）：
 *   1. 过滤插件注入的 user/message（运行时上下文快照、技能清单等 source.kind === 'plugin'），
 *      默认只保留真正的用户消息；--keep-plugin 可保留。
 *   2. 流式 chunk（assistant/chunk、*-chunks）不直接使用——assistant/message 事件携带
 *      权威的完整消息，直接用它能天然去重、避免乱码与重复。
 *   3. 工具调用 arguments 字符串尝试解析为 JSON；tool/result 按 callId 挂回对应工具调用。
 *   4. 逐行容错解析：损坏的行跳过并计数，不影响其余消息。
 *   5. 连续完全相同的消息去重。
 *
 * 用法示例：
 *   node session-to-conversation.cjs --in session.jsonl
 *   node session-to-conversation.cjs --in dsh-session-xxx.zip --out ./out --formats md,json
 *   node session-to-conversation.cjs --in ./logs --no-reasoning --no-tools
 *   node session-to-conversation.cjs --help
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const HELP = `
session-to-conversation.cjs — DSH 会话日志清洗并转换为对话记录（多种格式）

用法:
  node session-to-conversation.cjs --in <session.jsonl|*.zip|目录> [选项]

选项:
  --in <path>            输入：session.jsonl 文件 / DSH 导出 .zip / 目录（默认 ./session.jsonl）
  --out <dir>            输出目录（默认 ./conversation-export）
  --formats <list>       逗号分隔: md,txt,html,json,jsonl,openai（默认全部）
  --keep-plugin          保留插件注入的用户消息（运行时上下文/技能提醒），默认过滤
  --no-reasoning         丢弃推理块（reasoning）
  --no-tools             丢弃工具调用与工具结果（纯问答）
  --max-tool-result <n>  工具结果文本截断长度（默认 2000，0 表示不截断）
  --title <text>         覆盖会话标题
  --list                 只列出 zip/目录 中的 session，不转换
  --help                 显示本帮助

输出文件（每个 session 一组）:
  <name>.conversation.md     Markdown 对话记录（可折叠推理/工具详情）
  <name>.conversation.txt    纯文本对话记录
  <name>.conversation.html   单文件自包含 HTML 记录
  <name>.conversation.json   结构化 JSON（meta + messages）
  <name>.conversation.jsonl  每行一条消息
  <name>.conversation.openai.json  OpenAI Chat Completions 兼容格式

示例:
  node session-to-conversation.cjs --in session.jsonl
  node session-to-conversation.cjs --in dsh-session-xxx.zip --formats md,html
  node session-to-conversation.cjs --in ./logs --no-tools --max-tool-result 800
`;

function parseArgs(argv) {
  const opts = {
    in: null,
    out: 'conversation-export',
    formats: ['md', 'txt', 'html', 'json', 'jsonl', 'openai'],
    keepPlugin: false,
    reasoning: true,
    tools: true,
    maxToolResult: 2000,
    title: null,
    list: false,
    help: false,
  };
  const known = new Set(['--in', '--out', '--formats', '--max-tool-result', '--title']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--keep-plugin') { opts.keepPlugin = true; continue; }
    if (a === '--no-reasoning') { opts.reasoning = false; continue; }
    if (a === '--no-tools') { opts.tools = false; continue; }
    if (a === '--list') { opts.list = true; continue; }
    if (known.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`选项 ${a} 缺少参数值`);
      if (a === '--in') opts.in = v;
      else if (a === '--out') opts.out = v;
      else if (a === '--formats') {
        opts.formats = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      } else if (a === '--max-tool-result') {
        opts.maxToolResult = Number(v);
        if (!Number.isFinite(opts.maxToolResult) || opts.maxToolResult < 0) throw new Error('--max-tool-result 需要非负整数');
      } else if (a === '--title') opts.title = v;
      continue;
    }
    throw new Error(`未知选项: ${a}（用 --help 查看用法）`);
  }
  return opts;
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

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

/** 尝试把工具调用 arguments 字符串解析为对象；失败返回 null（保留原文）。 */
function tryParseArgs(raw) {
  if (typeof raw !== 'string') return { ok: false, value: raw };
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch { return { ok: false, value: raw }; }
}

/** 从 content block 列表提取纯文本（只拼接 text 块）。 */
function blocksToText(blocks) {
  return (blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function safeName(s) {
  return String(s).replace(/[^\w\u4e00-\u9fff-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'session';
}

/* ------------------------------------------------------------------ */
/* 最小 ZIP 读取器（仅 STORE 与 DEFLATE；读取 DSH 导出归档足够）            */
/* ------------------------------------------------------------------ */

function readZipEntries(buf) {
  // 定位 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  while (p + 46 <= end && buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const out = [];
  for (const e of entries) {
    if (e.name.endsWith('/')) continue; // 目录项
    const lp = e.localOffset;
    const nameLen = buf.readUInt16LE(lp + 26);
    const extraLen = buf.readUInt16LE(lp + 28);
    const dataStart = lp + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + e.compSize);
    let raw;
    if (e.method === 0) raw = data;
    else if (e.method === 8) raw = zlib.inflateRawSync(data);
    else throw new Error(`ZIP 条目不支持压缩方式: ${e.method}（${e.name}）`);
    out.push({ name: e.name, data: raw });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 输入解析                                                             */
/* ------------------------------------------------------------------ */

function isZipFile(p) { return /\.zip$/i.test(p); }
function isJsonlFile(p) { return /\.jsonl$/i.test(p); }

/** 收集输入路径下的所有 session 日志文件（jsonl/zip）。返回 {name, jsonlText?|zipBuf?} 列表。 */
function collectInputs(inPath, opts) {
  const stat = fs.statSync(inPath);
  const results = [];
  if (stat.isFile()) {
    if (isZipFile(inPath)) {
      results.push({ name: path.basename(inPath, path.extname(inPath)), kind: 'zip', path: inPath });
    } else if (isJsonlFile(inPath)) {
      results.push({ name: path.basename(inPath, path.extname(inPath)), kind: 'jsonl', path: inPath });
    } else {
      results.push({ name: path.basename(inPath, path.extname(inPath)), kind: 'jsonl', path: inPath });
    }
    return results;
  }
  // 目录：递归收集
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (isZipFile(entry.name) || isJsonlFile(entry.name)) {
        results.push({
          name: path.basename(entry.name, path.extname(entry.name)),
          kind: isZipFile(entry.name) ? 'zip' : 'jsonl',
          path: full,
        });
      }
    }
  };
  walk(inPath);
  return results;
}

/** 把一个输入源展开为 {sessionId, sourcePath, text} 列表（zip 可能含多个 jsonl）。 */
function expandSource(src) {
  if (src.kind === 'jsonl') {
    const text = fs.readFileSync(src.path, 'utf8');
    return [{ sourcePath: src.path, text }];
  }
  const buf = fs.readFileSync(src.path);
  const entries = readZipEntries(buf);
  const jsonls = entries.filter((e) => /\.jsonl$/i.test(e.name));
  if (jsonls.length === 0) throw new Error(`ZIP 中未找到 *.jsonl: ${src.path}`);
  return jsonls.map((e) => ({ sourcePath: `${src.path}!/${e.name}`, text: e.data.toString('utf8') }));
}

/* ------------------------------------------------------------------ */
/* 事件解析（容错）                                                      */
/* ------------------------------------------------------------------ */

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
      else { broken++; if (!brokenSample) brokenSample = `第 ${i + 1} 行: 缺少 type 字段`; }
    } catch {
      broken++;
      if (!brokenSample) brokenSample = `第 ${i + 1} 行: JSON 解析失败（该行前 120 字符: ${line.slice(0, 120)}）`;
    }
  }
  events.sort((a, b) => {
    const sa = a.seq !== undefined ? a.seq : a.seq0;
    const sb = b.seq !== undefined ? b.seq : b.seq0;
    return (sa ?? 0) - (sb ?? 0);
  });
  return { events, broken, brokenSample };
}

/* ------------------------------------------------------------------ */
/* 对话重建（"清洗"核心）                                                 */
/* ------------------------------------------------------------------ */

function buildConversation(rawEvents, opts) {
  const meta = {
    sessionId: null,
    title: null,
    createdAt: null,
    cwd: null,
    delegationDepth: null,
    agentPreset: null,
    model: null,
    provider: null,
    systemPrompt: null,
    sourceFile: null,
  };
  const messages = [];
  let currentTurn = null;
  let currentStep = null;
  let lastAssistant = null; // 最近的 assistant message（挂 tool-result / usage）
  const toolResultsByCall = new Map(); // callId -> {blocks, isError, time}
  let droppedPlugin = 0;
  let droppedDup = 0;

  // 第一遍：收集 tool/result（它们可能在 assistant/message 之前或之后，先按 callId 存）
  const toolResults = [];
  for (const e of rawEvents) {
    if (e.type === 'tool/result') {
      const blocks = e.data?.message?.content || [];
      toolResults.push({
        callId: e.data?.message?.source?.callId,
        blocks,
        isError: blocks.some((b) => b.isError) || e.data?.message?.content?.some((b) => b.isError === true),
        time: e.time,
        seq: e.seq,
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
        // 只保留真正的用户消息（kind='user'）与工具结果消息（kind='tool'）；
        // 插件注入的运行时上下文/技能清单等一律过滤（--keep-plugin 可保留）。
        const injected = kind !== 'user' && kind !== 'tool';
        if (injected && !opts.keepPlugin) { droppedPlugin++; break; }
        const msg = {
          role: 'user',
          id: d.id || null,
          time: fmtTime(e.time),
          turn: currentTurn,
          step: currentStep,
          kind,
          source: d.source || null,
          content: normalizeContentBlocks(d.content || []),
        };
        pushMessage(messages, msg, () => { droppedDup++; });
        lastAssistant = null;
        break;
      }

      case 'assistant/message': {
        const d = e.data || {};
        const m = d.message || {};
        const content = normalizeContentBlocks(m.content || []);
        const msg = {
          role: 'assistant',
          id: m.id || null,
          time: fmtTime(e.time),
          turn: d.turn ?? currentTurn,
          step: d.step ?? currentStep,
          kind: 'model',
          source: m.source || null,
          content,
          usage: d.usage || null,
        };
        if (msg.source?.model) meta.model = msg.source.model;
        if (msg.source?.provider) meta.provider = msg.source.provider;
        pushMessage(messages, msg, () => { droppedDup++; });
        lastAssistant = msg;
        break;
      }

      case 'tool/result': {
        // 由第一遍收集的 toolResults 统一在收尾时挂接
        break;
      }

      default:
        break; // chunk 事件、request/*、权限事件、inbox 等一律忽略
    }
  }

  // 收尾：把 tool/result 挂到对应 assistant 消息的工具调用上
  for (const tr of toolResults) {
    const target = findAssistantWithCall(messages, tr.callId);
    // tr.blocks 通常是 [{type:'tool-result', toolCallId, content:[...], isError}]，
    // 剥掉外层，直接取内层 content（text 块数组）。
    const normalized = normalizeContentBlocks(tr.blocks);
    let inner = normalized;
    if (normalized.length === 1 && normalized[0]?.type === 'tool-result' && Array.isArray(normalized[0].content)) {
      inner = normalized[0].content;
    }
    const block = {
      type: 'tool-result',
      toolCallId: tr.callId,
      isError: !!tr.isError,
      time: fmtTime(tr.time),
      content: inner,
    };
    if (target) target.content.push(block);
    else {
      // 没有对应 assistant 消息（异常顺序）→ 独立 user 消息兜底
      pushMessage(messages, {
        role: 'user',
        id: null,
        time: tr.time ? fmtTime(tr.time) : null,
        turn: null,
        step: null,
        kind: 'tool-result',
        source: { kind: 'tool' },
        content: [block],
      }, () => {});
    }
  }

  // 清洗：应用 --no-reasoning / --no-tools，并去掉空的 tool-result 引用
  for (const m of messages) {
    m.content = m.content.filter((b) => {
      if (b.type === 'reasoning' && !opts.reasoning) return false;
      if (b.type === 'tool-call' && !opts.tools) return false;
      if (b.type === 'tool-result' && !opts.tools) return false;
      return true;
    });
    // 解析 arguments
    for (const b of m.content) {
      if (b.type === 'tool-call') b.argumentsParsed = tryParseArgs(b.arguments);
    }
  }

  // 最终统计
  const stats = {
    messages: messages.length,
    userMessages: messages.filter((m) => m.role === 'user' && m.kind !== 'tool-result').length,
    assistantMessages: messages.filter((m) => m.role === 'assistant').length,
    toolCalls: messages.reduce((n, m) => n + m.content.filter((b) => b.type === 'tool-call').length, 0),
    toolResults: messages.reduce((n, m) => n + m.content.filter((b) => b.type === 'tool-result').length, 0),
    reasoningBlocks: messages.reduce((n, m) => n + m.content.filter((b) => b.type === 'reasoning').length, 0),
    turns: new Set(messages.map((m) => m.turn).filter((t) => t != null)).size,
    droppedPlugin,
    droppedDup,
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
        type: 'tool-result',
        toolCallId: b.toolCallId,
        isError: !!b.isError,
        content: normalizeContentBlocks(b.content),
      });
    } else {
      // 未知块类型：尽力保留
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
    const has = m.content.some((b) => b.type === 'tool-call' && b.id === callId);
    if (has) return m;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 渲染器                                                               */
/* ------------------------------------------------------------------ */

function toolResultText(block, opts) {
  const parts = (block.content || []).map((b) => b.text || '').join('\n');
  return truncateText(parts, opts.maxToolResult);
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

/* ---------- Markdown ---------- */

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
      if (b.type === 'text') {
        out.push(b.text);
        out.push('');
      } else if (b.type === 'reasoning') {
        out.push('<details>');
        out.push('<summary>💭 推理过程</summary>');
        out.push('');
        out.push(b.text);
        out.push('');
        out.push('</details>');
        out.push('');
      } else if (b.type === 'tool-call') {
        out.push('<details>');
        out.push(`<summary>🔧 工具调用: <code>${b.name}</code>${b.id ? `（${b.id}）` : ''}</summary>`);
        out.push('');
        out.push('```json');
        out.push(b.argumentsParsed?.ok ? JSON.stringify(b.argumentsParsed.value, null, 2) : b.arguments);
        out.push('```');
        out.push('');
        out.push('</details>');
        out.push('');
      } else if (b.type === 'tool-result') {
        out.push('<details>');
        out.push(`<summary>📥 工具结果${b.isError ? '（错误）' : ''}: <code>${b.toolCallId || ''}</code></summary>`);
        out.push('');
        out.push('```text');
        out.push(toolResultText(b, opts));
        out.push('```');
        out.push('');
        out.push('</details>');
        out.push('');
      }
    }
  }
  return out.join('\n') + '\n';
}

/* ---------- 纯文本 ---------- */

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
      else if (b.type === 'reasoning') {
        out.push('--- 推理过程 ---');
        out.push(b.text);
        out.push('--- 推理结束 ---');
      } else if (b.type === 'tool-call') {
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

/* ---------- Markdown → HTML（零依赖，GFM 常用子集，与 GUI 核心一致） ---------- */

function mdSafeUrl(u) {
  const s = String(u).trim();
  if (s === '') return false;
  if (/^(javascript|data|vbscript):/i.test(s)) return false;
  return true;
}

function mdInline(text) {
  let t = escHtml(String(text));
  const tokens = [];
  t = t.replace(/`([^`\n]+)`/g, (m, c) => {
    tokens.push('<code>' + c + '</code>');
    return '\u0000MD' + (tokens.length - 1) + '\u0000';
  });
  t = t.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()]*\))*)(?:\s+"[^"]*")?\)/g, (m, alt, url) =>
    mdSafeUrl(url) ? '<img src="' + escHtml(url) + '" alt="' + escHtml(alt) + '" loading="lazy">' : m);
  t = t.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()]*\))*)(?:\s+"[^"]*")?\)/g, (m, text, url) =>
    mdSafeUrl(url) ? '<a href="' + escHtml(url) + '" target="_blank" rel="noreferrer">' + text + '</a>' : text);
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  t = t.replace(/\u0000MD(\d+)\u0000/g, (m, i) => tokens[Number(i)]);
  return t;
}

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
    while (i < lines.length) {
      const cont = lines[i].match(/^(\s*)(\S.*)$/);
      if (!cont || cont[1].length <= baseIndent) break;
      if (/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) break;
      text += '\n' + cont[2];
      i++;
    }
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
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const lvl = h[1].length;
      out.push('<h' + lvl + '>' + mdInline(h[2]) + '</h' + lvl + '>');
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^>\s?/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote>' + renderMarkdownHtml(quote.join('\n')) + '</blockquote>');
      continue;
    }
    const tbl = mdTryTable(lines, i);
    if (tbl) { flush(); out.push(tbl.html); i = tbl.next; continue; }
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const list = mdRenderList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }
    if (trimmed === '') { flush(); i++; continue; }
    para.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

/* ---------- HTML ---------- */

function renderHtml(conv, opts) {
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
  const blocks = [];
  for (const b of conv.messages) {
    const who = b.role === 'user' ? 'user' : 'assistant';
    const label = b.role === 'user' ? '👤 用户' : '🤖 助手';
    const pos = b.turn != null ? ` · 回合 ${b.turn}` + (b.step != null ? ` · 步骤 ${b.step}` : '') : '';
    const time = b.time ? ` · ${b.time.local}` : '';
    let body = '';
    for (const c of b.content) {
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
    blocks.push(`<div class="msg ${who}"><div class="head">${label}${pos}${time}</div>${body}</div>`);
  }
  const statLine = `消息 ${stats.messages} · 回合 ${stats.turns} · 工具调用 ${stats.toolCalls}` +
    (stats.inputTokens + stats.outputTokens > 0 ? ` · Token 输入 ${stats.inputTokens} / 输出 ${stats.outputTokens}` : '') +
    (stats.droppedPlugin > 0 ? ` · 过滤插件消息 ${stats.droppedPlugin}` : '');
  const modelLine = meta.provider ? `${meta.provider} / ${meta.model}` : (meta.model || '-');
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
${blocks.join('\n')}
<div class="foot">由 session-to-conversation.cjs 从 DSH 会话日志生成 · ${new Date().toISOString()}</div>
</div>
</body>
</html>
`;
}

/* ---------- JSON ---------- */

function cleanJsonContent(blocks, opts) {
  return blocks.map((b) => {
    if (b.type === 'text' || b.type === 'reasoning') return { type: b.type, text: b.text };
    if (b.type === 'tool-call') {
      return { type: 'tool-call', id: b.id, name: b.name, arguments: b.argumentsParsed?.ok ? b.argumentsParsed.value : b.arguments };
    }
    if (b.type === 'tool-result') {
      return {
        type: 'tool-result',
        toolCallId: b.toolCallId,
        isError: b.isError,
        content: cleanJsonContent(b.content, opts).map((x) => (x.type === 'text' ? { type: 'text', text: truncateText(x.text, opts.maxToolResult) } : x)),
      };
    }
    return b;
  });
}

function renderJson(conv, opts) {
  const out = {
    format: 'dsh-conversation',
    version: 1,
    meta: {
      sessionId: conv.meta.sessionId,
      title: conv.meta.title,
      createdAt: conv.meta.createdAt,
      cwd: conv.meta.cwd,
      delegationDepth: conv.meta.delegationDepth,
      agentPreset: conv.meta.agentPreset,
      model: conv.meta.model,
      provider: conv.meta.provider,
    },
    stats: conv.stats,
    messages: conv.messages.map((m) => ({
      role: m.role,
      id: m.id,
      time: m.time,
      turn: m.turn,
      step: m.step,
      kind: m.kind,
      source: m.source,
      usage: m.usage,
      content: cleanJsonContent(m.content, opts),
    })),
  };
  return JSON.stringify(out, null, 2) + '\n';
}

/* ---------- JSONL ---------- */

function renderJsonl(conv, opts) {
  return conv.messages.map((m) => JSON.stringify({
    role: m.role,
    id: m.id,
    time: m.time,
    turn: m.turn,
    step: m.step,
    kind: m.kind,
    source: m.source,
    usage: m.usage,
    content: cleanJsonContent(m.content, opts),
  })).join('\n') + '\n';
}

/* ---------- OpenAI Chat Completions ---------- */

function renderOpenAI(conv, opts) {
  const messages = [];
  for (const m of conv.messages) {
    if (m.role === 'user' && m.kind === 'tool-result') continue; // 由 tool 角色表达
    if (m.role === 'user') {
      const text = blocksToText(m.content);
      messages.push({ role: 'user', content: text });
      continue;
    }
    // assistant
    const text = blocksToText(m.content);
    const reasoning = m.content.find((b) => b.type === 'reasoning')?.text || null;
    const toolCalls = m.content
      .filter((b) => b.type === 'tool-call')
      .map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: b.argumentsParsed?.ok ? JSON.stringify(b.argumentsParsed.value) : String(b.arguments ?? '') },
      }));
    const entry = { role: 'assistant', content: text || null };
    if (reasoning && opts.reasoning) entry.reasoning_content = reasoning;
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    messages.push(entry);
    // tool results 紧随其后
    const results = m.content.filter((b) => b.type === 'tool-result');
    for (const r of results) {
      messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: toolResultText(r, opts) });
    }
  }
  return JSON.stringify({ model: conv.meta.model || null, messages }, null, 2) + '\n';
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

const RENDERERS = {
  md: { ext: '.conversation.md', render: renderMarkdown },
  txt: { ext: '.conversation.txt', render: renderPlainText },
  html: { ext: '.conversation.html', render: renderHtml },
  json: { ext: '.conversation.json', render: renderJson },
  jsonl: { ext: '.conversation.jsonl', render: renderJsonl },
  openai: { ext: '.conversation.openai.json', render: renderOpenAI },
};

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`错误: ${err.message}\n`); console.error(HELP); process.exit(2); }

  if (opts.help) { console.log(HELP); return; }

  const inPath = opts.in || 'session.jsonl';
  if (!fs.existsSync(inPath)) {
    console.error(`错误: 输入不存在: ${inPath}`);
    process.exit(2);
  }

  const sources = collectInputs(inPath, opts);
  if (sources.length === 0) {
    console.error(`错误: 在 ${inPath} 中未找到 *.jsonl 或 *.zip`);
    process.exit(2);
  }

  if (opts.list) {
    for (const s of sources) console.log(`${s.kind === 'zip' ? '[zip]' : '[jsonl]'} ${s.path}`);
    return;
  }

  const badFormats = opts.formats.filter((f) => !(f in RENDERERS));
  if (badFormats.length > 0) {
    console.error(`错误: 未知格式 ${badFormats.join(', ')}（可用: ${Object.keys(RENDERERS).join(',')}）`);
    process.exit(2);
  }

  fs.mkdirSync(opts.out, { recursive: true });

  let converted = 0;
  for (const src of sources) {
    let texts;
    try { texts = expandSource(src); }
    catch (err) {
      console.error(`跳过 ${src.path}: ${err.message}`);
      continue;
    }
    for (const { sourcePath, text } of texts) {
      const { events, broken, brokenSample } = parseEvents(text);
      const conv = buildConversation(events, opts);
      conv.meta.sourceFile = sourcePath;
      if (opts.title) conv.meta.title = opts.title;
      if (!conv.meta.title) conv.meta.title = conv.meta.sessionId ? `会话 ${conv.meta.sessionId.slice(0, 8)}` : '(未命名会话)';

      const base = safeName(conv.meta.title || 'session');
      let written = [];
      for (const f of opts.formats) {
        const spec = RENDERERS[f];
        let content;
        try { content = spec.render(conv, opts); }
        catch (err) { console.error(`  渲染 ${f} 失败: ${err.message}`); continue; }
        const outFile = path.join(opts.out, `${base}${spec.ext}`);
        fs.writeFileSync(outFile, content, 'utf8');
        written.push(outFile);
      }
      converted++;
      console.log(`✔ ${sourcePath}`);
      console.log(`  标题: ${conv.meta.title}`);
      console.log(`  消息: ${conv.stats.messages}（用户 ${conv.stats.userMessages} / 助手 ${conv.stats.assistantMessages}）· 工具调用 ${conv.stats.toolCalls}${broken > 0 ? ` · 损坏行 ${broken}` : ''}${conv.stats.droppedPlugin > 0 ? ` · 过滤插件消息 ${conv.stats.droppedPlugin}` : ''}`);
      for (const f of written) console.log(`  → ${f}`);
      if (broken > 0 && brokenSample) console.warn(`  ⚠ 有 ${broken} 行无法解析（${brokenSample}）`);
    }
  }
  console.log(`\n完成：共转换 ${converted} 个 session，输出目录: ${path.resolve(opts.out)}`);
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  parseEvents,
  buildConversation,
  renderMarkdown,
  renderPlainText,
  renderHtml,
  renderJson,
  renderJsonl,
  renderOpenAI,
  readZipEntries,
};
