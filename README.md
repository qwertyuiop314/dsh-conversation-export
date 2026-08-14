# DSH 会话日志 → 对话记录 转换工具

把 DSH（DeepSeek Harness）导出的原始会话日志"洗"成可读、可复用、可分享的对话记录，支持多种格式。
三套入口共用同一份清洗与渲染逻辑：

- **🖥️ 图形界面**：`session-conversation-gui.html` —— 双击即用、零安装、可离线
- **⌨️ 命令行**：`session-to-conversation.cjs` —— 零依赖（仅 Node 内置模块），适合批量与脚本化
- **🔌 DSH Web 插件**：`plugin/@deepseek-ai/dsh-session-conversation-export` —— 在 Session 头部
  "Session log" 左侧加"Export chat"按钮，弹窗勾选格式导出

## 目录结构

```
dsh-conversation-export/
├── session-to-conversation.cjs        # CLI 工具（零依赖）
├── session-conversation-gui.html      # 单文件图形界面（核心逻辑内嵌）
├── build-plugin.cjs                   # 由 GUI 核心生成插件 bundle（单一来源）
├── plugin/
│   └── @deepseek-ai/dsh-session-conversation-export/   # DSH Web 插件包
│       ├── package.json               # dsh.client 声明
│       └── lib/{index.js, client.js}  # 宿主半部 + 浏览器 bundle
├── scripts/
│   ├── test-gui-core.cjs              # 离线回归测试（GUI 核心 vs samples）
│   └── validate-plugin.cjs            # 离线验证插件 bundle（loader 模拟 + 核心一致性）
├── deploy/                            # 部署相关（需要已安装的 DSH）
│   ├── restart-dsh-web.ps1            # 重启 dsh web 服务（含中文提示）
│   ├── 重启DSH服务.bat                 # 双击重启（Windows）
│   ├── verify-install.cjs             # 校验插件已安装（路径按本机调整）
│   ├── test-picker.cjs                # 在线验证：导出格式选择逻辑
│   └── e2e-plugin.cjs                 # 在线端到端：按钮流程模拟
├── samples/
│   └── session.jsonl                  # 合成示例日志（非真实数据，供离线测试）
├── README.md
└── LICENSE                            # MIT
```

## 一、背景：DSH 为什么需要这个工具

DSH 目前只有**导出日志**能力：Web 界面 Session 头部 `Session log` 按钮或 `/export` 斜杠命令，
通过 `GET /api/session.export` 下载一个 ZIP，内含当前 Session、子 Session 与附件的**原始事件日志**
（每行一个 JSON 事件，UTF-8）。

原始日志是给机器看的事件流：包含 `reasoning-chunks` / `text-chunks` / `tool-call-chunks` 等流式
增量、`request/header` 系统提示、`agent/inbox/spliced` 队列操作、插件注入的运行时上下文快照与
技能清单……直接打开很难读，也不适合分享或二次利用。

本工具就是"缺的那一环"：**读取原始日志 → 清洗 → 重建为结构化对话 → 多种格式输出**。

## 二、会话日志格式（本工具识别的关键事件）

DSH Session 日志每行一个 JSON 事件，按 `seq`（提交序）排列；流式增量事件用 `seq0`/`time0`：

| 事件类型 | 用途 | 本工具的处理 |
|---|---|---|
| `session` | 会话头：id / createdAt / cwd / agentPreset | 元信息 |
| `session/title` | 会话标题 | 元信息 |
| `user/message` | 用户消息（`source.kind` 区分来源） | **保留 `user` / `tool`，过滤其余** |
| `assistant/message` | **权威的完整助手消息**（含 reasoning / text / tool-call 块、usage、model） | 重建核心 |
| `tool/call` | 工具调用（callId / name / arguments） | 与助手消息的 tool-call 块一致 |
| `tool/result` | 工具结果（按 callId 关联） | **挂回对应助手消息** |
| `turn/start` `turn/end` `step/start` `step/end` | 回合 / 步骤边界 | 标注在消息上 |
| `request/header` | 模型 / provider / 系统提示 | 元信息（模型名） |
| `assistant/chunk` `*-chunks` | 流式增量 | **忽略**（assistant/message 已含完整内容） |
| `agent/inbox/spliced` 等 | 运行时内部事件 | 忽略 |

## 三、清洗规则（"洗一下"做了什么）

1. **过滤注入消息**：`user/message` 中 `source.kind` 为 `plugin` / `skill-catalog` / `system`
   等非用户来源的消息默认剔除，只保留真正的用户消息与工具结果消息（`--keep-plugin` 可保留）。
2. **以 `assistant/message` 为准**：流式 chunk 事件不参与重建，天然去重，并规避流式分片乱码。
3. **工具调用与结果配对**：`arguments` 解析为 JSON（失败保留原文），按 `callId` 把 `tool/result`
   挂回对应助手消息，标记 `isError`。
4. **逐行容错**：单行损坏只跳过并计数报告，不影响其余消息。
5. **连续重复去重**：相邻且完全相同的消息只保留一条。
6. **可裁剪**：`--no-reasoning` / `--no-tools` / `--max-tool-result`。

## 四、输出格式（六种）

| 后缀 | 格式 | 用途 |
|---|---|---|
| `.conversation.md` | Markdown | 人读：标题/元信息 + 逐条消息；推理、工具调用、工具结果折叠在 `<details>` |
| `.conversation.txt` | 纯文本 | 极简可读，便于终端 / 粘贴 |
| `.conversation.html` | 单文件 HTML | 自包含样式、深浅色、折叠详情；**正文 Markdown 已渲染**（内置零依赖渲染器，含 XSS 防护） |
| `.conversation.json` | 结构化 JSON | `{meta, stats, messages[]}`，content 块类型化，工具参数已解析 |
| `.conversation.jsonl` | 每行一条消息 | 流式处理 / 日志管线友好 |
| `.conversation.openai.json` | OpenAI Chat Completions 兼容 | assistant 带 `reasoning_content` 与 `tool_calls`，工具结果以 `role:"tool"` 紧随 |

所有格式共享同一份重建后的对话模型，保证内容一致。

## 五、命令行用法

```
node session-to-conversation.cjs --in <session.jsonl|*.zip|目录> [选项]
```

- **输入**：单个 `session.jsonl`；单个 `.zip`（内置最小 ZIP 读取器，支持 STORE/DEFLATE）；
  或一个目录（递归扫描其中所有 `*.jsonl` / `*.zip`）。
- **选项**：`--out <dir>`（默认 `./conversation-export`）、`--formats md,txt,html,json,jsonl,openai`、
  `--keep-plugin`、`--no-reasoning`、`--no-tools`、`--max-tool-result <n>`（默认 2000，0=不截断）、
  `--title <text>`、`--list`、`--help`。

示例：

```bash
node session-to-conversation.cjs --in samples/session.jsonl
node session-to-conversation.cjs --in dsh-session-xxx.zip --formats md,html
node session-to-conversation.cjs --in ./logs --no-reasoning --no-tools
node session-to-conversation.cjs --in session.jsonl --formats openai --out ./llm-context
```

## 六、图形界面（session-conversation-gui.html）

单文件、零依赖、离线可用。支持拖放/点选 `.jsonl` / `.json` / `.zip`，多会话管理、实时选项、
六种格式下载、全部打包 ZIP、复制 Markdown、容错提示。旧浏览器缺少 `DecompressionStream` 时
ZIP 会提示，`.jsonl` 仍可用。

## 七、DSH Web 插件（右上角 "Export chat" 按钮）

插件在 Session 页面右上角 **"Session log" 左侧**新增 "Export chat" 按钮：点击后弹窗勾选格式
（默认 Markdown），单选直接下载单文件、多选打包 ZIP。全程浏览器内完成，无服务端改动。

**安装（重启 DSH Web 后生效）：**

1. 把 `plugin/@deepseek-ai/dsh-session-conversation-export` 复制到
   `~/.dsh/profiles/node_modules/@deepseek-ai/`（若 node_modules 是 pnpm 管理，推荐登记为
   `file:` 依赖并指向用户级源码目录，防止被清理）。
2. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: session-conversation-export
         name: '@deepseek-ai/dsh-session-conversation-export'
   ```

3. 重启 `dsh web`，刷新页面。

**更新插件**：修改 `session-conversation-gui.html` 后运行 `node build-plugin.cjs` 重新生成
bundle，再同步到安装位置。浏览器刷新即可生效（bundle 按请求从磁盘读取，无需重启服务）。

**卸载**：从 cordis.patch.yml 删掉 insert 条目，删除 node_modules 中的包，重启即可。

## 八、开发与测试

```bash
# 1) 离线回归：GUI 核心 + 六种渲染器 + Markdown 渲染（用 samples/ 合成数据）
node scripts/test-gui-core.cjs

# 2) 离线验证：插件 bundle 的 loader 注册 / 核心一致性 / 导出过滤器
node scripts/validate-plugin.cjs

# 3) 重新生成插件 bundle（改过 GUI 核心后必须执行）
node build-plugin.cjs

# 4) 在线验证（需要运行中的 DSH + DSH_SESSION_ID）
node deploy/test-picker.cjs
node deploy/e2e-plugin.cjs
```

设计约定：GUI 的 `<script id="core-logic">` 是核心逻辑的唯一来源；`build-plugin.cjs` 从中提取
生成插件 bundle；CLI 版 `session-to-conversation.cjs` 与之保持一致（测试保证 Markdown 输出逐字节相同）。

## 九、与 DSH 的集成路径（可选）

1. **CLI 子命令**：在 DSH 源码仓库新增 `dsh session export-conversation`，复用本工具的
   `parseEvents` / `buildConversation` / 渲染器（已 `module.exports` 导出）。
2. **Web 端导出入口**：仿照 `dsh-session-log-export` 贡献 header 按钮的方式，Host 侧可增加
   `GET /api/session.conversation?format=...` 端点。
3. **复用点**：清洗与重建逻辑是零依赖纯函数，放任意包都能跑，便于单测。

## 十、已知限制

- 仅处理单层事件流；子 Session（`delegationDepth > 0`）由导出 ZIP 中的独立 `*.jsonl` 表达，
  每个文件分别转换（可用 `--list` 查看 ZIP 内容）。
- 附件（图片等）不在 JSONL 内，转换结果不含图片本体。
- ZIP 读取器仅支持 STORE 与 DEFLATE（DSH 导出归档满足）。
- 工具结果文本默认截断到 2000 字符（`--max-tool-result` 可调），完整内容仍在原始日志中。
