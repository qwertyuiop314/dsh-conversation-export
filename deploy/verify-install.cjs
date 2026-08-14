// Verify the installed plugin is discoverable exactly as client-modules does it.
// Deployment-specific: hardcodes the local DSH profile paths for THIS machine.
// Usage: node deploy/verify-install.cjs   (adjust the paths below for your machine)
'use strict';
const { createRequire } = require('module');
const fs = require('fs');
const path = require('path');

const profileWeb = 'C:/Users/USER/.dsh/profiles/web';
const req = createRequire(profileWeb + '/');

// 1) 宿主入口可解析（loader 装载）
const hostPath = req.resolve('@deepseek-ai/dsh-session-conversation-export');
console.log('✔ 宿主入口可解析:', hostPath);

// 2) 模拟 client-modules resolveMeta
const pkgPath = req.resolve('@deepseek-ai/dsh-session-conversation-export/package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const decl = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh.client : undefined;
console.log('✔ dsh.client 声明:', JSON.stringify(decl));
if (!decl || decl.platform !== 'web') { console.error('✘ platform 不是 web'); process.exit(1); }
const client = pkg.exports && pkg.exports['./client'];
console.log('✔ exports["./client"]:', JSON.stringify(client));
const clientPath = path.join(path.dirname(pkgPath), client);
console.log('✔ client bundle 存在:', fs.existsSync(clientPath), `(${fs.statSync(clientPath).size} B)`);

// 3) patch YAML 可解析
let yamlOk = true;
try {
  const yaml = req.resolve('js-yaml');
  const loaded = require(yaml);
  const text = fs.readFileSync('C:/Users/USER/.dsh/profiles/web/cordis.patch.yml', 'utf8');
  const doc = loaded.load(text);
  const inserts = doc.filter((row) => row && row.insert);
  const found = inserts.some((row) => row.insert.some((e) => e.id === 'session-conversation-export' && e.name === '@deepseek-ai/dsh-session-conversation-export'));
  console.log('✔ cordis.patch.yml 解析 OK · 找到插件条目:', found);
  if (!found) yamlOk = false;
} catch (err) {
  console.log('js-yaml 不可用，跳过 YAML 结构校验:', err.message);
  const raw = fs.readFileSync('C:/Users/USER/.dsh/profiles/web/cordis.patch.yml', 'utf8');
  yamlOk = raw.includes('session-conversation-export') && raw.includes('@deepseek-ai/dsh-session-conversation-export');
}
if (!yamlOk) process.exit(1);
console.log('全部通过 ✔');
