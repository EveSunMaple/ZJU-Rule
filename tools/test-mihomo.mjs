/**
 * 用真的 mihomo 二进制校验生成的配置。
 *
 *   node tools/test-mihomo.mjs
 *
 * 这是最权威的一关：mihomo 就是 Clash Verge / Clash Meta / Mihomo 的内核，
 * 它说能加载，客户端就一定不会报「订阅配置校验失败」。
 *
 * 之前踩过的坑：
 *   - USER-AGENT 规则（Clash Premium 时代的写法，Mihomo 已移除）
 *   - URL-REGEX 规则（同样不被支持）
 *   - global-client-fingerprint（v1.19+ 已移除该配置项）
 * 这些都是手写规则表容易漏掉的，交给真内核来判定最可靠。
 *
 * 二进制缺失时会尝试自动下载；下载失败则跳过并给出提示。
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convert } from '../lib/engine/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(ROOT, 'local', 'bin');
const MIHOMO = path.join(BIN_DIR, 'mihomo');
const WORK = path.join(ROOT, 'local', 'tmp', 'mihomo-test');

const MIHOMO_VERSION = 'v1.19.30';

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

/* ------------------------------ 准备二进制 ------------------------------ */

async function ensureMihomo() {
  if (existsSync(MIHOMO)) return true;

  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const asset =
    process.platform === 'darwin'
      ? `mihomo-darwin-${arch}-${MIHOMO_VERSION}.gz`
      : `mihomo-linux-${arch}-${MIHOMO_VERSION}.gz`;

  const url = `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${asset}`;
  console.log(`首次运行：正在下载 mihomo (${asset}) …`);

  try {
    await mkdir(BIN_DIR, { recursive: true });
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const gz = path.join(BIN_DIR, asset);
    await pipeline(res.body, createWriteStream(gz));

    // .gz 单文件压缩，直接用 zlib 解
    const { gunzipSync } = await import('node:zlib');
    await writeFile(MIHOMO, gunzipSync(await readFile(gz)));
    await rm(gz, { force: true });

    const { chmodSync } = await import('node:fs');
    chmodSync(MIHOMO, 0o755);
    return true;
  } catch (err) {
    console.log(`  ⚠ 无法获取 mihomo（${err.message}），跳过真内核校验。`);
    console.log('    可以手动下载后放到 local/bin/mihomo 再跑这个测试。\n');
    return false;
  }
}

/* ------------------------------ 核心校验 ------------------------------ */

/** 用 mihomo 测试一份配置，返回 {ok, errors, warnings}。 */
async function testConfig(configText, name) {
  const dir = path.join(WORK, name);
  const file = path.join(dir, 'config.yaml');

  await mkdir(dir, { recursive: true });
  await writeFile(file, configText, 'utf8');

  const res = spawnSync(MIHOMO, ['-t', '-d', dir, '-f', file], { encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;

  const errors = out
    .split('\n')
    .filter((l) => l.includes('level=error'))
    .map((l) => l.replace(/^.*?msg=/, '').replace(/^"|"$/g, ''));

  const warnings = out
    .split('\n')
    .filter((l) => l.includes('level=warning'))
    .map((l) => l.replace(/^.*?msg=/, '').replace(/^"|"$/g, ''));

  return {
    ok: out.includes('test is successful') && errors.length === 0,
    errors,
    warnings,
    raw: out,
  };
}

/* ------------------------------ 测试数据 ------------------------------ */

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function makeSubscription(links) {
  return b64(links.join('\n'));
}

const FULL_SUB = makeSubscription([
  `ss://${b64('aes-256-gcm:pw123')}@1.2.3.4:8388#香港 IEPL 01`,
  `ss://${b64('aes-128-gcm:pw123')}@1.2.3.5:8388#日本 东京 02`,
  'trojan://pw123@jp.example.com:443?sni=jp.example.com#日本 Trojan 03',
  `vmess://${b64(JSON.stringify({
    v: '2', ps: '美国 洛杉矶 04', add: 'us.example.com', port: '443',
    id: 'b8315e1b-1a2b-4321-8b1a-2c3d4e5f6a7b', aid: '0', scy: 'auto',
    net: 'ws', type: 'none', host: 'us.example.com', path: '/ws', tls: 'tls',
  }))}`,
  'vless://11111111-2222-3333-4444-555555555555@sg.example.com:443?encryption=none&security=tls&sni=sg.example.com&type=ws&path=%2Fws#新加坡 05',
  'hysteria2://pw123@hk2.example.com:8443?sni=hk2.example.com&insecure=1#香港 Hysteria2 06',
]);

/** 只有一个节点，用来验证「策略组大面积为空」时的裁剪逻辑。 */
const ONE_NODE_SUB = makeSubscription([
  `ss://${b64('aes-256-gcm:pw')}@9.9.9.9:8388#唯一节点`,
]);

/** 名字很奇怪的节点，用来验证 YAML 转义。 */
const WEIRD_SUB = makeSubscription([
  `ss://${b64('aes-256-gcm:p@ss:w"rd#{}[]')}@1.2.3.4:8388#带"引号"和:冒号,逗号的 节点`,
  `vmess://${b64(JSON.stringify({
    v: '2', ps: 'emoji 🇭🇰 与中文 & 符号 <tag>', add: 'x.example.com', port: '443',
    id: 'b8315e1b-1a2b-4321-8b1a-2c3d4e5f6a7b', aid: '0', net: 'tcp', tls: '',
  }))}`,
]);

/* ------------------------------ 开始 ------------------------------ */

console.log('\nmihomo 真内核校验\n');

if (!(await ensureMihomo())) {
  skipped = 1;
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项，跳过 ${skipped} 项\n`);
  process.exit(0);
}

await mkdir(WORK, { recursive: true });

const ctx = { origin: null, fsRoot: ROOT, cacheKey: `mihomo-${Date.now()}` };

const CASES = [
  ['默认配置', { subUrl: FULL_SUB }, {}],
  ['关闭广告拦截', { subUrl: FULL_SUB, disabledRuleSets: [
    'https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/Clash/BanEasyList.list',
    'https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/Clash/BanEasyPrivacy.list',
    'https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/Clash/BanEasyListChina.list',
  ] }, {}],
  ['带自定义规则', { subUrl: FULL_SUB, customRules: [
    { rule: 'my-lab.zju.edu.cn', policy: '✔ ZJU内网' },
    { rule: 'chat.openai.com', policy: '🚀 节点选择' },
    { rule: 'ads.example.com', policy: 'REJECT' },
    { rule: 'IP-CIDR,10.20.0.0/16', policy: 'DIRECT' },
    { rule: 'DOMAIN-KEYWORD,steam', policy: 'DIRECT' },
  ] }, {}],
  ['单节点（策略组大面积为空）', { subUrl: ONE_NODE_SUB }, {}],
  ['特殊字符节点名/密码', { subUrl: WEIRD_SUB }, {}],
  ['关闭 emoji / 开启排序', { subUrl: FULL_SUB, options: { emoji: false, sort: true, appendType: true } }, {}],
  ['改用其它规则配置', { subUrl: FULL_SUB, profile: '/Clash/config/ACL4SSR_Mini.ini' }, {}],
  ['校园网模式（校内 DNS）', { subUrl: FULL_SUB, base: '/configs/clash-base-campus.yaml' }, {}],
  ['普通模式（公共 DNS）', { subUrl: FULL_SUB, base: '/configs/clash-base.yaml' }, {}],
  ['混合模式（base64 节点列表）', { subUrl: FULL_SUB, target: 'mixed' }, { skipMihomo: true }],
];

for (const [label, request, opts = {}] of CASES) {
  if (opts.skipMihomo) {
    // 非 Clash 输出不走 mihomo 校验，只确认能生成
    try {
      const res = await convert(request, ctx);
      check(`${label}（非 Clash 输出，只检查能生成）`, res.body.length > 0);
    } catch (err) {
      check(`${label}`, false, err.message);
    }
    continue;
  }

  let result;
  try {
    result = await convert(request, ctx);
  } catch (err) {
    check(`${label}：生成配置`, false, err.message);
    continue;
  }

  const t = await testConfig(result.body, label.replace(/[^\w\u4e00-\u9fa5]+/g, '_'));

  check(
    `${label}（${result.meta.nodeCount} 节点 / ${result.meta.groupCount} 组 / ${result.meta.ruleCount} 规则）`,
    t.ok,
    t.errors.slice(0, 3).join('\n      ') || t.raw.split('\n').slice(-2).join('\n      '),
  );

  // 顺带确认没有被 mihomo 警告的配置项
  const deprecations = t.warnings.filter((w) => /deprecated|removed|please set/i.test(w));
  if (deprecations.length) {
    check(`${label}：无过时配置项`, false, deprecations.join(' / '));
  }
}

/* --- 反向验证：故意放一条不支持的规则，确认测试真的能抓到问题 --- */
console.log('\n反向验证（确认这个测试不是摆设）');
{
  const baseline = await convert({ subUrl: FULL_SUB }, ctx);
  const broken = baseline.body.replace(
    /^(rules:\n)/m,
    '$1  - "USER-AGENT,OneDrive*,🚀 节点选择"\n',
  );
  const t = await testConfig(broken, "__negative__");
  check(
    '故意插入 USER-AGENT 规则时，mihomo 校验能抓出来',
    !t.ok && t.errors.some((e) => /USER-AGENT/.test(e)),
    `预期失败但通过了。errors=${JSON.stringify(t.errors.slice(0, 2))}`,
  );
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
