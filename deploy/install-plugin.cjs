#!/usr/bin/env node
/**
 * install-plugin.cjs — 一键安装 dsh-session-conversation-export 插件（幂等，可重复运行）
 *
 * 自动完成三件事：
 *   1. 把插件包装进 DSH profile（优先 `dsh plugin add file:...`，需 pnpm；否则手动复制）
 *   2. 在 profile 的 package.json 登记 file: 依赖（防 pnpm 清理；已有则跳过）
 *   3. 在 cordis.patch.yml 追加装载条目（已存在则跳过）
 *
 * 用法：
 *   node deploy/install-plugin.cjs                    # 默认 profile=web
 *   node deploy/install-plugin.cjs --profile web
 *   node deploy/install-plugin.cjs --dsh-home C:\Users\xxx\.dsh
 * 或直接双击同目录的「安装插件.bat」（Windows）。
 *
 * 装完后：重启 dsh web（见 deploy/重启DSH服务.bat），刷新浏览器即出现 Export chat 按钮。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

/** 执行一条命令；成功返回 true（stdout 静默），失败返回 false。 */
function tryRun(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); return true; }
  catch { return false; }
}
/** 执行一条命令并透传输出；返回退出码。 */
function runVisible(cmd) {
  try { execSync(cmd, { stdio: 'inherit' }); return 0; }
  catch (err) { return err.status ?? 1; }
}

const PKG = '@deepseek-ai/dsh-session-conversation-export';
const INSERT_BLOCK = `# 会话导出对话插件（install-plugin.cjs 写入）：Session 头部 "Export chat" 按钮
- insert:
    - id: session-conversation-export
      name: '${PKG}'`;

const args = process.argv.slice(2);
const val = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const profileName = val('--profile') || 'web';
const dshHome = val('--dsh-home') || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

const SRC = path.join(__dirname, '..', 'plugin', PKG);
const profileRoot = path.join(dshHome, 'profiles', profileName);
const sharedNodeModules = path.join(dshHome, 'profiles', 'node_modules', PKG);
const patchFile = path.join(profileRoot, 'cordis.patch.yml');
const manifestFile = path.join(profileRoot, 'package.json');

const log = (m) => console.log(m);
const fail = (m) => { console.error('✘ ' + m); process.exit(1); };

// ---------- 0. 校验 ----------
if (!fs.existsSync(SRC)) fail(`在仓库中找不到插件包: ${SRC}`);
if (!fs.existsSync(profileRoot)) fail(`profile 不存在: ${profileRoot}\n   请先至少运行过一次该 profile（如 dsh web），或检查 --profile / --dsh-home 参数`);

// ---------- 1. 安装插件包 ----------
let installedBy = null;
const pnpmOk = tryRun('pnpm --version');
const dshOk = tryRun('dsh --version');
if (pnpmOk && dshOk) {
  log('检测到 pnpm + dsh，尝试 `dsh plugin add file:...` 安装…');
  const code = runVisible('dsh plugin --profile ' + profileName + ' add "file:' + SRC + '"');
  if (code === 0) installedBy = 'dsh plugin add';
  else log('  dsh plugin add 未成功（退出码 ' + code + '），回退为手动安装');
}
if (!installedBy) {
  log('手动安装插件包到: ' + sharedNodeModules);
  fs.mkdirSync(path.dirname(sharedNodeModules), { recursive: true });
  fs.rmSync(sharedNodeModules, { recursive: true, force: true });
  fs.cpSync(SRC, sharedNodeModules, { recursive: true });
  installedBy = 'manual copy';
}
log('✔ 插件包已安装（方式: ' + installedBy + '）');

// ---------- 2. 登记 file: 依赖（防 pnpm 清理；dsh plugin add 已登记则跳过） ----------
if (fs.existsSync(manifestFile)) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const deps = manifest.dependencies || {};
  if (deps[PKG]) {
    log('✔ package.json 已有依赖登记，跳过: ' + deps[PKG]);
  } else {
    // 指向用户级源码目录，避免依赖仓库相对位置
    const userLevelDir = path.join(dshHome, 'plugins', PKG);
    if (!fs.existsSync(userLevelDir)) {
      fs.mkdirSync(path.dirname(userLevelDir), { recursive: true });
      fs.cpSync(SRC, userLevelDir, { recursive: true });
    }
    deps[PKG] = 'file:' + path.relative(profileRoot, userLevelDir).replace(/\\/g, '/');
    manifest.dependencies = deps;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    log('✔ 已在 package.json 登记依赖: ' + deps[PKG]);
  }
}

// ---------- 3. 装载条目 ----------
// 经 dsh plugin add 安装时：包内 dsh.bundle 已加入 profile bundles 层，
// 其 cordis.patch.yml 自动注入装载条目，无需（也不应）再改 profile 的 patch 文件。
// 手动复制兜底时：没有 bundle 层，必须写 profile 的 cordis.patch.yml。
if (installedBy === 'dsh plugin add') {
  log('✔ 走官方 dsh plugin add：装载条目已由包内 bundle patch 注入（无需手动改 cordis.patch.yml）');
} else {
  let patch = '';
  if (fs.existsSync(patchFile)) patch = fs.readFileSync(patchFile, 'utf8');
  if (patch.includes('session-conversation-export') && patch.includes(PKG)) {
    log('✔ cordis.patch.yml 已有插件条目，跳过');
  } else {
    const addition = (patch.trim() === '' ? '' : '\n') + INSERT_BLOCK + '\n';
    fs.writeFileSync(patchFile, patch + addition, 'utf8');
    log('✔ 已写入 cordis.patch.yml 装载条目: ' + patchFile);
  }
}

// ---------- 4. 完成提示 ----------
log('');
log('==========================================================');
log('安装完成！还差最后一步：重启 DSH Web 服务。');
log('  方式一：双击 deploy/重启DSH服务.bat');
log('  方式二：关掉 dsh web 后重新运行 dsh web');
log('然后刷新 http://127.0.0.1:3080，Session 右上角即出现 Export chat 按钮。');
log('（验证安装：node deploy/verify-install.cjs）');
log('==========================================================');
