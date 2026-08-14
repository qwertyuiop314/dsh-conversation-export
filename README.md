# DSH 会话日志 → 对话记录

把 DSH 导出的原始会话日志清洗为对话记录，三套入口共用同一套逻辑：

| 入口 | 位置 | 说明 |
|---|---|---|
| 🔌 DSH 插件 | Session 头部 "Export chat" 按钮 | 弹窗勾选格式，单选直下、多选 ZIP |
| 🖥️ GUI | `session-conversation-gui.html` | 双击即用、零安装、可离线 |
| ⌨️ CLI | `session-to-conversation.cjs` | 零依赖（Node ≥18），适合批量 |

## 安装（插件）

**官方一条命令（推荐）**——在仓库目录下：

```bash
# 一次性前提：装 pnpm（dsh plugin 是 pnpm 转发器）
npm i -g pnpm

# 一键安装：装包 + 自动加入 profile bundles 层 + 注入装载条目
dsh plugin --profile web add file:./plugin/@deepseek-ai/dsh-session-conversation-export

# 重启后生效
dsh web   # 或 重启DSH服务.bat
```

插件包内声明了 `dsh.bundle`（`cordis.patch.yml`），所以 `dsh plugin add` 会自动把它加入
`dsh.profile.bundles` 并在启动时注入 "Export chat" 装载条目——**无需再手动改任何配置文件**。

**或一键脚本**：双击 `deploy/安装插件.bat`（有 pnpm 时内部就走上面的官方命令；否则手动复制兜底）。

**手动（兜底）**：复制 `plugin/@deepseek-ai/dsh-session-conversation-export/` 到
`$DSH_HOME/profiles/node_modules/@deepseek-ai/`，并在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: session-conversation-export
      name: '@deepseek-ai/dsh-session-conversation-export'
```

重启 `dsh web`，刷新页面。

## 用法

```bash
# CLI：单文件 / 导出 ZIP / 目录，默认输出 6 种格式
node session-to-conversation.cjs --in session.jsonl
node session-to-conversation.cjs --in dsh-session-xxx.zip --formats md,html
node session-to-conversation.cjs --in ./logs --no-tools --max-tool-result 800

# GUI：双击 html，拖入 .jsonl / .zip
# 插件：右上角 Export chat → 勾选格式 → 导出
```

输出格式：`.md` / `.txt` / `.html`（正文 Markdown 已渲染）/ `.json` / `.jsonl` / `.openai.json`（OpenAI 兼容）。

## 开发与测试

```bash
node scripts/test-gui-core.cjs   # 离线回归（GUI 核心 + 渲染器 + Markdown）
node scripts/validate-plugin.cjs # 离线验证插件 bundle
node build-plugin.cjs            # 改过 GUI 核心后重新生成插件 bundle
node deploy/verify-install.cjs   # 校验插件已装好（需已装 DSH）
```

## 已知限制

- 子会话由导出 ZIP 中的独立 `*.jsonl` 表达，逐个转换。
- 附件（图片）不在日志内，转换结果只含文本。
- ZIP 读取仅支持 STORE / DEFLATE。
- 工具结果默认截断 2000 字符（`--max-tool-result` 可调）。

## 关于本仓库的"出生证明"

本仓库的代码是**人类与 AI 的混合双打**产物：人类负责提需求、定方向、亲自下场调试和最后把关，代码的"手"（其实是 token）主要出自模型。

请把它当作一份**参考实现**来用——就像菜谱：照着做可以，但别指望不粘锅：

- **用之前自己先过目**：代码翻一翻、测试跑一跑、按你的场景调一调；看不懂也没关系，让 AI 帮你把关——反正代码是 AI 写的，AI 审 AI，专业对口；
- 代码按 **"现状"（AS-IS）** 提供，不附带任何明示或默示的担保——没有保修卡，也没有延保服务；
- 要是哪里翻车了，那大概率是 AI 的锅——欢迎提 issue 或 PR 帮它"补课"，我们绝不护短；
- 欢迎 **fork、修改、分发**，也欢迎提 issue 或 PR 一起改进——独乐乐不如众乐乐。

**说人话**：代码能用就偷着乐，踩坑了一起填，改好了记得回来分享 😄
