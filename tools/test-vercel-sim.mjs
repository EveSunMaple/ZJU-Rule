/**
 * Vercel 部署等价性测试。
 *
 *   node tools/test-vercel-sim.mjs
 *
 * 做法：把构建产物 public/ 用一个纯静态服务器托管起来，然后用
 * **和 Vercel Function 完全相同的调用方式** 去跑 lib/handler.mjs：
 *   - fsRoot = null   （Vercel 上没有仓库文件系统，只能通过 HTTP 取规则）
 *   - origin = 静态服务器地址
 *   - subconverterBackend = '' （故意不配后端，验证「零依赖开箱可用」）
 *
 * 这是整个「复活」目标的核心验证：证明只部署到 Vercel 就能用。
 */

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { handleSub } from '../lib/handler.mjs';
import { buildRuleCatalog } from '../lib/catalog.mjs';
import { validate } from './validate-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.list': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
};

/** 极简静态服务器，模拟 Vercel 的静态资源托管。 */
function startStaticServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const abs = path.normalize(path.join(OUT, rel));

    if (!abs.startsWith(OUT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const info = await stat(abs);
      if (!info.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
      res.end(await readFile(abs));
    } catch {
      res.writeHead(404).end('404');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label}\n      ${String(err.message).split('\n').slice(0, 5).join('\n      ')}`);
  }
}

/* ------------------------------------------------------------------ */

// 先起静态服务器拿到端口，再用「这个端口」当作部署域名去构建 ——
// 这样产物和 Vercel 上完全一致（规则源指向部署域名本身）。
const { server, port } = await startStaticServer();
const ORIGIN = `http://127.0.0.1:${port}`;

console.log(`\nVercel 等价性测试（静态站点 ${ORIGIN}，无任何外部后端）\n`);

console.log('构建');
await check('以 SITE_URL 作为部署域名构建成功', async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/vercel-build.mjs')], {
    cwd: ROOT,
    env: { ...process.env, SITE_URL: ORIGIN, SUBCONVERTER_BACKEND: '' },
    stdio: 'pipe',
  });
  const info = await stat(OUT);
  if (!info.isDirectory()) throw new Error('没有生成 public/');
});

// 造一份测试订阅，放进构建产物里，让函数通过 HTTP 去抓（走真实链路）
const DEMO_NAME = '__test-demo.txt';
const demoLinks = [
  `ss://${Buffer.from('aes-256-gcm:pw123').toString('base64')}@1.2.3.4:8388#香港 IEPL 01`,
  `ss://${Buffer.from('aes-128-gcm:pw123').toString('base64')}@1.2.3.5:8388#日本 东京 02`,
  'trojan://pw123@jp.example.com:443?sni=jp.example.com#日本 Trojan 03',
  `vmess://${Buffer.from(
    JSON.stringify({
      v: '2', ps: '美国 洛杉矶 04', add: 'us.example.com', port: '443',
      id: 'b8315e1b-1a2b-4321-8b1a-2c3d4e5f6a7b', aid: '0', scy: 'auto',
      net: 'ws', type: 'none', host: 'us.example.com', path: '/ws', tls: 'tls',
    }),
  ).toString('base64')}`,
  'vless://11111111-2222-3333-4444-555555555555@sg.example.com:443?encryption=none&security=tls&sni=sg.example.com&type=ws&path=%2Fws#新加坡 05',
  'hysteria2://pw123@hk2.example.com:8443?sni=hk2.example.com&insecure=1#香港 Hysteria2 06',
].join('\n');

await writeFile(path.join(OUT, DEMO_NAME), Buffer.from(demoLinks).toString('base64'), 'utf8');
const SUB_URL = `${ORIGIN}/${DEMO_NAME}`;

// 模拟 Vercel Function 的调用上下文：没有文件系统，没有 subconverter
const ctx = { origin: ORIGIN, fsRoot: null, cacheKey: 'vercel-sim', subconverterBackend: '' };

console.log('构建产物');
await check('public/ 已生成', async () => {
  const info = await stat(OUT);
  if (!info.isDirectory()) throw new Error('public/ 不存在，请先运行 npm run build');
});

await check('规则文件已部署', async () => {
  const res = await fetch(`${ORIGIN}/Clash/ZJU.list`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('zju.edu.cn')) throw new Error('ZJU.list 内容不对');
});

await check('基础配置已部署', async () => {
  const res = await fetch(`${ORIGIN}/configs/clash-base.yaml`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('mixed-port')) throw new Error('clash-base.yaml 内容不对');
});

await check('规则配置已部署且规则源指向本站', async () => {
  const res = await fetch(`${ORIGIN}/Clash/config/ZJU.ini`);
  const text = await res.text();
  if (!text.includes(`${ORIGIN}/Clash/ZJU.list`)) {
    throw new Error(`ZJU.ini 里的规则源没有指向本站：${text.split('\n')[3]}`);
  }
});

console.log('\n零依赖转换（模拟 Vercel Function 调用）');
let configText = '';

await check('handleSub 用内置引擎成功转换', async () => {
  const url = new URL(`${ORIGIN}/sub`);
  url.searchParams.set('target', 'clash');
  url.searchParams.set('url', `${SUB_URL}`);
  url.searchParams.set('config', '/Clash/config/ZJU.ini');

  const res = await handleSub(url, ctx);
  if (res.status !== 200) throw new Error(`状态码 ${res.status}：${res.body.slice(0, 300)}`);
  configText = res.body;
  if (res.headers['X-ZJU-Engine'] !== 'builtin') throw new Error('没有走内置引擎');
  if (res.headers['X-ZJU-Nodes'] !== '6') throw new Error(`节点数应为 6，实际 ${res.headers['X-ZJU-Nodes']}`);
});

await check('生成的配置通过结构校验', () => {
  const { errors, stats } = validate(configText);
  if (errors.length) throw new Error(errors.slice(0, 5).join(' / '));
  if (stats.rules < 10000) throw new Error(`规则只有 ${stats.rules} 条`);
  if (stats.groups < 20) throw new Error(`策略组只有 ${stats.groups} 个`);
});

await check('包含 ZJU 分流规则和策略组', () => {
  if (!configText.includes('"DOMAIN-SUFFIX,zju.edu.cn,✔ ZJU内网"')) throw new Error('缺 ZJU 域名规则');
  if (!configText.includes('name: "✔ ZJU内网"')) throw new Error('缺 ZJU 内网策略组');
  if (!configText.includes('"IP-CIDR,10.0.0.0/8,✔ ZJU内网,no-resolve"')) throw new Error('缺 ZJU 内网 IP 规则');
  if (!configText.includes('"MATCH,🐟 漏网之鱼"')) throw new Error('缺 MATCH 兜底');
});

await check('基础配置被正确套用', () => {
  if (!configText.includes('mixed-port: 7890')) throw new Error('缺 mixed-port');
  if (!/^dns:/m.test(configText)) throw new Error('缺 dns 段');
  if (!/^sniffer:/m.test(configText)) throw new Error('缺 sniffer 段');
});

console.log('\n规则集清单接口');
await check('/api/rules 逻辑可用', async () => {
  const catalog = await buildRuleCatalog('/Clash/config/ZJU.ini', ctx);
  if (!catalog.ok) throw new Error(catalog.error);
  if (catalog.ruleSets.length < 20) throw new Error(`规则集只有 ${catalog.ruleSets.length} 个`);
  if (!catalog.ruleSets.some((r) => r.name === 'ZJU' && r.policy === '✔ ZJU内网')) {
    throw new Error('清单里没有 ZJU 规则集');
  }
});

console.log('\n同学自定义规则的完整链路');
await check('自定义规则通过 URL 参数生效', async () => {
  const custom = Buffer.from(
    JSON.stringify([
      { rule: 'my-lab.zju.edu.cn', policy: '✔ ZJU内网' },
      { rule: 'chat.openai.com', policy: '🚀 节点选择' },
    ]),
  ).toString('base64');

  const url = new URL(`${ORIGIN}/sub`);
  url.searchParams.set('target', 'clash');
  url.searchParams.set('url', `${SUB_URL}`);
  url.searchParams.set('config', '/Clash/config/ZJU.ini');
  url.searchParams.set('custom', custom);

  const res = await handleSub(url, ctx);
  if (res.status !== 200) throw new Error(res.body.slice(0, 200));
  if (!res.body.includes('"DOMAIN-SUFFIX,my-lab.zju.edu.cn,✔ ZJU内网"')) {
    throw new Error('自定义域名规则没生效');
  }
  if (!res.body.includes('"DOMAIN-SUFFIX,chat.openai.com,🚀 节点选择"')) {
    throw new Error('自定义代理规则没生效');
  }
});

await check('关掉广告规则集后体积明显变小', async () => {
  const disable = Buffer.from(
    JSON.stringify([
      `${ORIGIN}/Clash/BanEasyList.list`,
      `${ORIGIN}/Clash/BanEasyPrivacy.list`,
      `${ORIGIN}/Clash/BanEasyListChina.list`,
    ]),
  ).toString('base64');

  const url = new URL(`${ORIGIN}/sub`);
  url.searchParams.set('target', 'clash');
  url.searchParams.set('url', `${SUB_URL}`);
  url.searchParams.set('config', '/Clash/config/ZJU.ini');
  url.searchParams.set('disable', disable);

  const res = await handleSub(url, ctx);
  if (res.status !== 200) throw new Error(res.body.slice(0, 200));
  const slim = Number(res.headers['X-ZJU-Rules']);
  if (!(slim < 40000)) throw new Error(`关掉后规则数仍有 ${slim} 条`);
  if (!res.body.includes('"DOMAIN-SUFFIX,zju.edu.cn,✔ ZJU内网"')) throw new Error('ZJU 规则不该被关掉');
});

console.log('\n错误提示');
await check('不支持的 target 给出可操作提示', async () => {
  const url = new URL(`${ORIGIN}/sub`);
  url.searchParams.set('target', 'surge');
  url.searchParams.set('url', `${SUB_URL}`);
  const res = await handleSub(url, ctx);
  if (res.status !== 501) throw new Error(`状态码应为 501，实际 ${res.status}`);
  if (!res.body.includes('SUBCONVERTER_BACKEND')) throw new Error('提示里没有说明怎么解决');
});

await check('缺少订阅链接时提示清晰', async () => {
  const res = await handleSub(new URL(`${ORIGIN}/sub`), ctx);
  if (res.status !== 400) throw new Error(`状态码应为 400，实际 ${res.status}`);
  if (!res.body.includes('订阅链接')) throw new Error('提示不清晰');
});

await check('订阅抓不到时报错而不是崩溃', async () => {
  const url = new URL(`${ORIGIN}/sub`);
  url.searchParams.set('url', 'http://127.0.0.1:1/nope');
  const res = await handleSub(url, ctx);
  if (res.status < 400) throw new Error('应该报错');
  if (!res.body.includes('❌')) throw new Error('错误信息格式不对');
});

server.close();
console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
