/**
 * 内置引擎端到端测试。
 *
 *   node tools/test-engine.mjs
 *
 * 需要本地服务已经在跑（./local/start.sh），因为规则文件是通过站点提供的。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convert } from '../lib/engine/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8080';

const ctx = { origin: ORIGIN, fsRoot: ROOT, cacheKey: 'test' };

/** 造一份覆盖多种协议的测试订阅。 */
function buildDemoSubscription() {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const links = [
    `ss://${b64('aes-256-gcm:pw123')}@1.2.3.4:8388#香港 IEPL 01`,
    `ss://${b64('aes-128-gcm:pw123')}@1.2.3.5:8388#日本 东京 02`,
    'trojan://pw123@jp.example.com:443?sni=jp.example.com#日本 Trojan 03',
    `vmess://${b64(
      JSON.stringify({
        v: '2', ps: '美国 洛杉矶 04', add: 'us.example.com', port: '443',
        id: 'b8315e1b-1a2b-4321-8b1a-2c3d4e5f6a7b', aid: '0', scy: 'auto',
        net: 'ws', type: 'none', host: 'us.example.com', path: '/ws', tls: 'tls',
      }),
    )}`,
    'vless://11111111-2222-3333-4444-555555555555@sg.example.com:443?encryption=none&security=tls&sni=sg.example.com&type=ws&path=%2Fws#新加坡 05',
    'hysteria2://pw123@hk2.example.com:8443?sni=hk2.example.com&insecure=1#香港 Hysteria2 06',
  ];
  return { text: links.join('\n'), base64: Buffer.from(links.join('\n')).toString('base64') };
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
    console.log(`  ✗ ${label}\n      ${err.message.split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const demo = buildDemoSubscription();

// 把测试订阅写到站点上，让引擎通过 HTTP 抓（走真实链路）
const { writeFile } = await import('node:fs/promises');
await writeFile(path.join(ROOT, 'local/tmp/engine-demo.txt'), demo.base64, 'utf8');
const SUB_URL = `${ORIGIN}/local/tmp/engine-demo.txt`;

console.log(`\n内置引擎测试（origin=${ORIGIN}）\n`);

console.log('基础转换');
let clash = null;

await check('clash 转换成功', async () => {
  const res = await convert({ subUrl: SUB_URL, target: 'clash' }, ctx);
  clash = res.body;
  assert.ok(clash.length > 1000, `输出太短：${clash.length}`);
  assert.equal(res.meta.engine, 'builtin');
  assert.equal(res.meta.nodeCount, 6, `节点数应为 6，实际 ${res.meta.nodeCount}`);
});

await check('包含 6 个节点，协议解析正确', () => {
  assert.match(clash, /type: "ss"/);
  assert.match(clash, /type: "trojan"/);
  assert.match(clash, /type: "vmess"/);
  assert.match(clash, /type: "vless"/);
  assert.match(clash, /type: "hysteria2"/);
  assert.match(clash, /reality-opts|ws-opts/);
});

await check('节点名补齐了国旗 emoji', () => {
  assert.match(clash, /🇭🇰/);
  assert.match(clash, /🇯🇵/);
  assert.match(clash, /🇺🇸/);
  assert.match(clash, /🇸🇬/);
});

await check('应用了基础配置（端口 / DNS / 嗅探）', () => {
  assert.match(clash, /mixed-port: 7890/);
  assert.match(clash, /^dns:/m);
  assert.match(clash, /^sniffer:/m);
  assert.match(clash, /fake-ip/);
});

await check('生成了 ZJU 相关策略组', () => {
  assert.match(clash, /name: "✔ ZJU内网"/);
  assert.match(clash, /name: "🚀 节点选择"/);
  assert.match(clash, /name: "🇭🇰 香港节点"/);
});

await check('生成了 ZJU 分流规则', () => {
  assert.match(clash, /"DOMAIN-SUFFIX,zju.edu.cn,✔ ZJU内网"/);
  assert.match(clash, /"DOMAIN-KEYWORD,cc98,✔ ZJU内网"/);
  assert.match(clash, /"IP-CIDR,10.0.0.0\/8,✔ ZJU内网,no-resolve"/);
});

await check('规则集规模合理（>10000 条）', () => {
  const count = (clash.match(/^  - "/gm) || []).length;
  assert.ok(count > 10000, `规则/节点条目只有 ${count} 条`);
});

await check('末尾有 MATCH 兜底规则', () => {
  assert.match(clash, /"MATCH,🐟 漏网之鱼"/);
});

await check('no-resolve 修饰符位置正确（在策略组之后）', () => {
  const bad = clash.match(/^  - "IP-CIDR,[^"]*no-resolve,[^"]*"$/m);
  assert.equal(bad, null, `修饰符位置错误：${bad?.[0]}`);
});

await check('没有空策略组', () => {
  const empties = clash.match(/proxies:\n(\s*)$/gm);
  assert.equal(empties, null, '存在成员为空的策略组');
});

console.log('\n选项');
await check('exclude 过滤生效', async () => {
  const res = await convert({ subUrl: SUB_URL, target: 'clash', options: { exclude: '美国' } }, ctx);
  assert.equal(res.meta.nodeCount, 5);
  assert.doesNotMatch(res.body, /🇺🇸/);
});

await check('include 只保留匹配的节点', async () => {
  const res = await convert({ subUrl: SUB_URL, target: 'clash', options: { include: '香港' } }, ctx);
  assert.equal(res.meta.nodeCount, 2);
});

await check('emoji 可以关闭（只影响节点名，策略组名里的国旗是配置自带的）', async () => {
  const res = await convert({ subUrl: SUB_URL, target: 'clash', options: { emoji: false } }, ctx);
  const proxies = res.body.slice(res.body.indexOf('proxies:'), res.body.indexOf('proxy-groups:'));
  assert.doesNotMatch(proxies, /🇭🇰/, '节点名里不该有国旗');
  assert.match(proxies, /"香港 IEPL 01"/, '节点名应保持原样（含空格）');
});

await check('appendType 追加协议名', async () => {
  const res = await convert({ subUrl: SUB_URL, target: 'clash', options: { appendType: true } }, ctx);
  assert.match(res.body, /\[Trojan\]/);
});

await check('udp 可以关闭', async () => {
  const res = await convert({ subUrl: SUB_URL, target: 'clash', options: { udp: false } }, ctx);
  const proxies = res.body.slice(res.body.indexOf('proxies:'), res.body.indexOf('proxy-groups:'));
  assert.doesNotMatch(proxies, /udp: true/);
});

console.log('\n自定义规则（方便同学改规则的关键功能）');
await check('自定义域名规则被放在最前面', async () => {
  const res = await convert(
    {
      subUrl: SUB_URL,
      target: 'clash',
      customRules: [
        { rule: 'my-lab.example.edu.cn', policy: '✔ ZJU内网' },
        { rule: 'DOMAIN-KEYWORD,steam', policy: '🚀 节点选择' },
        { rule: 'IP-CIDR,192.168.100.0/24,no-resolve', policy: 'DIRECT' },
      ],
    },
    ctx,
  );
  assert.equal(res.meta.customRuleCount, 3);

  const rulesStart = res.body.indexOf('rules:');
  const head = res.body.slice(rulesStart, rulesStart + 600);
  assert.match(head, /"DOMAIN-SUFFIX,my-lab\.example\.edu\.cn,✔ ZJU内网"/);
  assert.match(head, /"DOMAIN-KEYWORD,steam,🚀 节点选择"/);
  assert.match(head, /"IP-CIDR,192\.168\.100\.0\/24,DIRECT,no-resolve"/);
});

await check('自定义规则优先级高于内置规则', async () => {
  const res = await convert(
    { subUrl: SUB_URL, target: 'clash', customRules: ['zju.edu.cn'], customRulesPolicy: 'DIRECT' },
    ctx,
  );
  const rules = res.body.slice(res.body.indexOf('rules:'));
  const custom = rules.indexOf('"DOMAIN-SUFFIX,zju.edu.cn,DIRECT"');
  const builtin = rules.indexOf('"DOMAIN-SUFFIX,zju.edu.cn,✔ ZJU内网"');
  assert.ok(custom >= 0, '自定义规则没写进去');
  assert.ok(custom < builtin, '自定义规则没有排在前面');
});

await check('不指定策略时用「节点选择」兜底', async () => {
  const res = await convert({ subUrl: SUB_URL, target: 'clash', customRules: ['foo.bar.com'] }, ctx);
  assert.match(res.body, /"DOMAIN-SUFFIX,foo\.bar\.com,🚀 节点选择"/);
});

await check('纯域名自动识别成 DOMAIN-SUFFIX', async () => {
  const res = await convert(
    { subUrl: SUB_URL, target: 'clash', customRules: ['foo.bar.com'], customRulesPolicy: 'DIRECT' },
    ctx,
  );
  assert.match(res.body, /"DOMAIN-SUFFIX,foo\.bar\.com,DIRECT"/);
});

await check('纯 IP 段自动识别成 IP-CIDR', async () => {
  const res = await convert(
    { subUrl: SUB_URL, target: 'clash', customRules: ['10.20.30.0/24'], customRulesPolicy: 'DIRECT' },
    ctx,
  );
  assert.match(res.body, /"IP-CIDR,10\.20\.30\.0\/24,DIRECT"/);
});

await check('*.example.org 自动规整成 DOMAIN-SUFFIX,example.org', async () => {
  const res = await convert(
    { subUrl: SUB_URL, target: 'clash', customRules: ['*.example.org'], customRulesPolicy: 'DIRECT' },
    ctx,
  );
  assert.match(res.body, /"DOMAIN-SUFFIX,example\.org,DIRECT"/);
});

console.log('\n裁剪规则集');
await check('可以关掉广告拦截规则集', async () => {
  const full = await convert({ subUrl: SUB_URL, target: 'clash' }, ctx);
  const slim = await convert(
    {
      subUrl: SUB_URL,
      target: 'clash',
      disabledRuleSets: [
        'https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/Clash/BanEasyList.list',
        'https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/Clash/BanEasyPrivacy.list',
        'https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/Clash/BanEasyListChina.list',
      ],
    },
    ctx,
  );
  assert.ok(
    slim.meta.ruleCount < full.meta.ruleCount,
    `关掉规则集后规则数没有变少：${slim.meta.ruleCount} vs ${full.meta.ruleCount}`,
  );
  // 被关掉的规则集不应再产生任何规则（规则行以策略组名结尾）
  assert.doesNotMatch(slim.body, /,🆎 AdBlock"$/m, '广告规则仍然存在');
  assert.doesNotMatch(slim.body, /,🛡️ 隐私防护"$/m, '隐私防护规则仍然存在');
  // 但 ZJU 规则必须还在
  assert.match(slim.body, /"DOMAIN-SUFFIX,zju\.edu\.cn,✔ ZJU内网"/);
});

console.log('\n输出格式');
await check('mixed 输出 base64 节点列表', async () => {
  const res = await convert({ subUrl: SUB_URL, target: 'mixed' }, ctx);
  const decoded = Buffer.from(res.body, 'base64').toString('utf8');
  assert.equal(decoded.split('\n').filter(Boolean).length, 6);
  assert.match(decoded, /^ss:\/\//m);
  assert.match(decoded, /^vmess:\/\//m);
});

console.log('\n错误处理');
await check('不支持的 target 给出明确提示', async () => {
  await assert.rejects(
    () => convert({ subUrl: SUB_URL, target: 'surge' }, ctx),
    /SUBCONVERTER_BACKEND|不支持/,
  );
});

await check('缺少订阅链接时报错', async () => {
  await assert.rejects(() => convert({ target: 'clash' }, ctx), /缺少订阅链接/);
});

await check('订阅抓不到时报错且不抛未捕获异常', async () => {
  await assert.rejects(
    () => convert({ subUrl: 'http://127.0.0.1:9/nope', target: 'clash' }, ctx),
    /抓取失败|所有订阅/,
  );
});

await check('空订阅内容报错', async () => {
  await assert.rejects(
    () => convert({ subUrl: 'not a subscription at all', target: 'clash' }, ctx),
    /没有解析出任何节点/,
  );
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
