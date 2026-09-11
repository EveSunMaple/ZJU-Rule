/**
 * 完整的用户旅程测试：模拟一个同学从打开网页到拿到可用订阅链接的全过程。
 *
 *   node tools/test-journey.mjs
 *
 * 需要本地服务已在运行（npm start）。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8080';

let passed = 0;
let failed = 0;

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

/** 模拟浏览器生成链接的那套逻辑。 */
function buildSubscribeUrl(base, { sub, target, config, custom = [], disable = [] }) {
  const params = new URLSearchParams();
  params.set('target', target);
  params.set('url', sub);
  params.set('config', config);
  for (const id of ['udp', 'scf', 'tfo', 'scv', 'emoji', 'append_type', 'sort']) {
    params.set(id, 'false');
  }
  if (custom.length) params.set('custom', Buffer.from(JSON.stringify(custom)).toString('base64'));
  if (disable.length) params.set('disable', Buffer.from(JSON.stringify(disable)).toString('base64'));
  return `${base}?${params.toString()}`;
}

const SUB = `${ORIGIN}/local/tmp/engine-demo.txt`;
const CONFIG = '/Clash/config/ZJU.ini';

console.log(`\n用户旅程测试（${ORIGIN}）\n`);

/* --- 1. 打开网页 --- */
console.log('① 打开网页');

const pageRes = await fetch(`${ORIGIN}/`);
const pageHtml = await pageRes.text();
check('首页返回 200', pageRes.status === 200, `状态码 ${pageRes.status}`);
check('页面包含规则设置面板', pageHtml.includes('规则设置') && pageHtml.includes('同学改这里'));
check('页面引用了运行时配置', pageHtml.includes('/zju-config.js'));
check('页面不再依赖 subconverter', !/subconverter 服务地址/.test(pageHtml));

const cfgRes = await fetch(`${ORIGIN}/zju-config.js`);
const cfgText = await cfgRes.text();
const cfg = JSON.parse(cfgText.replace(/^window\.__ZJU_CONFIG__ = /, '').replace(/;\s*$/, ''));
check('运行时配置可用', cfgRes.status === 200);
check('声明内置引擎可用', cfg.engineAvailable === true);
check('提供了规则配置列表', Array.isArray(cfg.profiles) && cfg.profiles.length > 20, `只有 ${cfg.profiles?.length} 个`);

/* --- 2. 查看规则清单 --- */
console.log('\n② 查看可选的规则集');

const catRes = await fetch(`${ORIGIN}/api/rules?config=${encodeURIComponent(CONFIG)}`);
const cat = await catRes.json();
check('规则清单接口可用', catRes.status === 200 && cat.ok === true, JSON.stringify(cat).slice(0, 120));
const toggleable = (cat.ruleSets || []).filter((r) => !r.inline);
check('列出了可开关的规则集', toggleable.length > 20, `只有 ${toggleable.length} 个`);
check('包含 ZJU 规则集', toggleable.some((r) => r.name === 'ZJU' && r.policy === '✔ ZJU内网'));
check('标记了体积大的规则集', toggleable.some((r) => r.heavy));
check('提供了策略组列表（给自定义规则的下拉框用）', (cat.groups || []).length > 20);

/* --- 3. 什么都不改，直接生成 --- */
console.log('\n③ 默认设置直接生成订阅');

const defaultUrl = buildSubscribeUrl(`${ORIGIN}/sub`, { sub: SUB, target: 'clash', config: CONFIG });
const defaultRes = await fetch(defaultUrl);
const defaultBody = await defaultRes.text();
check('转换成功', defaultRes.status === 200, `状态码 ${defaultRes.status}：${defaultBody.slice(0, 200)}`);
check('响应头带统计信息', Boolean(defaultRes.headers.get('X-ZJU-Nodes') && defaultRes.headers.get('X-ZJU-Rules')));
check('包含 ZJU 内网规则', defaultBody.includes('"DOMAIN-SUFFIX,zju.edu.cn,✔ ZJU内网"'));

const defaultRules = Number(defaultRes.headers.get('X-ZJU-Rules'));
const defaultSize = defaultBody.length;

/* --- 4. 应用「关闭广告拦截」预设 --- */
console.log('\n④ 应用预设「关闭广告拦截」');

const noadDisabled = toggleable
  .filter((r) => r.heavy || /Ban(AD|ProgramAD|EasyList|EasyListChina|EasyPrivacy)/i.test(r.path || ''))
  .map((r) => r.source);
check('预设选中了若干个规则集', noadDisabled.length >= 3, `选中 ${noadDisabled.length} 个`);

const noadUrl = buildSubscribeUrl(`${ORIGIN}/sub`, {
  sub: SUB, target: 'clash', config: CONFIG, disable: noadDisabled,
});
const noadRes = await fetch(noadUrl);
const noadBody = await noadRes.text();
const noadRules = Number(noadRes.headers.get('X-ZJU-Rules'));
check('转换成功', noadRes.status === 200);
check('规则数明显减少', noadRules < defaultRules * 0.7, `${noadRules} vs ${defaultRules}`);
check('体积明显变小', noadBody.length < defaultSize * 0.7, `${noadBody.length} vs ${defaultSize}`);
check('ZJU 规则保留', noadBody.includes('"DOMAIN-SUFFIX,zju.edu.cn,✔ ZJU内网"'));
check('广告规则已移除', !/,🆎 AdBlock"$/m.test(noadBody));

/* --- 5. 添加自定义规则 --- */
console.log('\n⑤ 添加自己的规则');

const custom = [
  { rule: 'my-lab.zju.edu.cn', policy: '✔ ZJU内网' },
  { rule: 'chat.openai.com', policy: '🚀 节点选择' },
  { rule: 'ads.example.com', policy: 'REJECT' },
  { rule: 'IP-CIDR,10.20.0.0/16', policy: 'DIRECT' },
];
const customUrl = buildSubscribeUrl(`${ORIGIN}/sub`, {
  sub: SUB, target: 'clash', config: CONFIG, custom,
});
const customRes = await fetch(customUrl);
const customBody = await customRes.text();

check('转换成功', customRes.status === 200);
check('自定义域名指向内网直连', customBody.includes('"DOMAIN-SUFFIX,my-lab.zju.edu.cn,✔ ZJU内网"'));
check('自定义域名走代理', customBody.includes('"DOMAIN-SUFFIX,chat.openai.com,🚀 节点选择"'));
check('自定义域名被拦截', customBody.includes('"DOMAIN-SUFFIX,ads.example.com,REJECT"'));
check('自定义 IP 段生效', customBody.includes('"IP-CIDR,10.20.0.0/16,DIRECT"'));

// 自定义规则必须排在所有内置规则之前才有效
const rulesSection = customBody.slice(customBody.indexOf('rules:'));
const customPos = rulesSection.indexOf('my-lab.zju.edu.cn');
const builtinPos = rulesSection.indexOf('DOMAIN-SUFFIX,zju.edu.cn,✔ ZJU内网');
check('自定义规则排在内置规则之前', customPos >= 0 && customPos < builtinPos);

/* --- 6. 校验生成的配置合法 --- */
console.log('\n⑥ 校验生成的配置');

const { validate } = await import('./validate-config.mjs');
for (const [label, body] of [['默认', defaultBody], ['无广告', noadBody], ['自定义', customBody]]) {
  const { errors, stats } = validate(body);
  check(
    `${label}配置结构合法（${stats.nodes} 节点 / ${stats.groups} 组 / ${stats.rules} 规则）`,
    errors.length === 0,
    errors.slice(0, 3).join(' / '),
  );
}

/* --- 7. 换客户端 --- */
console.log('\n⑦ 生成 base64 节点列表（给 Shadowrocket 等客户端）');

const mixedRes = await fetch(buildSubscribeUrl(`${ORIGIN}/sub`, { sub: SUB, target: 'mixed', config: CONFIG }));
const mixedBody = await mixedRes.text();
const decoded = Buffer.from(mixedBody, 'base64').toString('utf8');
check('转换成功', mixedRes.status === 200);
check('返回 base64 节点列表', /^ss:\/\//m.test(decoded) && /^vmess:\/\//m.test(decoded));
check('节点数量正确', decoded.split('\n').filter(Boolean).length === 6, `${decoded.split('\n').filter(Boolean).length} 条`);

/* --- 8. 错误场景给出人话提示 --- */
console.log('\n⑧ 出错时提示是否清楚');

const noSubRes = await fetch(`${ORIGIN}/sub?target=clash`);
const noSubText = await noSubRes.text();
check('缺少订阅链接时提示清楚', noSubRes.status === 400 && noSubText.includes('订阅链接'), noSubText.slice(0, 100));

const badSubRes = await fetch(buildSubscribeUrl(`${ORIGIN}/sub`, { sub: 'not-a-subscription', target: 'clash', config: CONFIG }));
const badSubText = await badSubRes.text();
check('订阅无效时提示清楚', badSubRes.status === 400 && /没有解析出任何节点/.test(badSubText), badSubText.slice(0, 120));

const badCfgRes = await fetch(buildSubscribeUrl(`${ORIGIN}/sub`, { sub: SUB, target: 'clash', config: '/Clash/config/不存在.ini' }));
const badCfgText = await badCfgRes.text();
check('规则配置不存在时提示清楚', badCfgRes.status >= 400 && /找不到规则配置/.test(badCfgText), badCfgText.slice(0, 120));

/* --- 9. 校园网模式 --- */
console.log('\n⑨ 校园网模式（开着系统代理也能上内网）');

const campusRes = await fetch(
  buildSubscribeUrl(`${ORIGIN}/sub`, { sub: SUB, target: 'clash', config: CONFIG }) +
    '&base=' + encodeURIComponent('/configs/clash-base-campus.yaml'),
);
const campusBody = await campusRes.text();
check('校园网模式转换成功', campusRes.status === 200, `状态码 ${campusRes.status}`);
check('使用校内 DNS 10.10.0.21', campusBody.includes('10.10.0.21'));
check('浙大域名强制走校内 DNS 解析', /nameserver-policy:/.test(campusBody) && /"\+\.zju\.edu\.cn": \[10\.10\.0\.21\]/.test(campusBody));
check('改用 redir-host 而不是 fake-ip', /enhanced-mode: redir-host/.test(campusBody));
check('不配置 fallback（避免内网域名被公共 DNS 覆盖）', !/^\s*fallback:/m.test(campusBody));
check('浙大规则仍然齐全', campusBody.includes('"DOMAIN-SUFFIX,zju.edu.cn,✔ ZJU内网"'));
check('TUN 模式下排除校内网段', /route-exclude-address:/.test(campusBody) && /10\.0\.0\.0\/8/.test(campusBody));

const campusCfg = validate(campusBody);
check('校园网配置结构合法', campusCfg.errors.length === 0, campusCfg.errors.slice(0, 3).join(' / '));

/* --- 10. 基础配置清单 --- */
console.log('\n⑩ 基础配置清单');

const bases = cat.bases || [];
check('清单里有普通模式', bases.some((b) => b.id === 'default'));
check('清单里有校园网模式', bases.some((b) => b.id === 'campus'));
for (const b of bases) {
  const r = await fetch(`${ORIGIN}${b.path}`);
  check(`基础配置可访问：${b.name}（${b.path}）`, r.ok, `HTTP ${r.status}`);
}

/* --- 11. PAC 文件（不开系统代理的方案）--- */
console.log('\n⑪ PAC 文件');

const pacRes = await fetch(`${ORIGIN}/proxy.pac`);
const pacText = await pacRes.text();
check('PAC 接口返回 200', pacRes.status === 200, `状态码 ${pacRes.status}`);
check('Content-Type 正确', /proxy-autoconfig/.test(pacRes.headers.get('content-type') || ''));
check('PAC 里有 FindProxyForURL', pacText.includes('function FindProxyForURL'));
check('PAC 指向本地代理端口', pacText.includes('PROXY 127.0.0.1:7890'));
check('PAC 里浙大域名直连', /ZJU_DOMAINS/.test(pacText) && pacText.includes('"zju.edu.cn":1'));
check('PAC 里 cc98.org 直连', pacText.includes('"cc98.org":1'));
check('PAC 里内网 IP 段直连', pacText.includes('10.0.0.0/8'));

const pacGlobal = await (await fetch(`${ORIGIN}/proxy.pac?mode=global`)).text();
check('可以切换为全局模式', pacGlobal.includes('DIRECT_DOMAINS') && !pacGlobal.includes('PROXY_DOMAINS,'));

/* --- 12. 补充规则（gfwlist 停更后缺失的域名）--- */
console.log('\n⑫ 补充的代理域名');

const extraUrl = buildSubscribeUrl(`${ORIGIN}/sub`, { sub: SUB, target: 'clash', config: CONFIG });
const extraBody = await (await fetch(extraUrl)).text();
check('x.com 走代理（gfwlist 停更后新增）', extraBody.includes('"DOMAIN-SUFFIX,x.com,🚀 节点选择"'));
check('chatgpt.com 走代理', extraBody.includes('"DOMAIN-SUFFIX,chatgpt.com,🚀 节点选择"'));
check('claude.ai 走代理', extraBody.includes('"DOMAIN-SUFFIX,claude.ai,🚀 节点选择"'));
check('threads.net 走代理', extraBody.includes('"DOMAIN-SUFFIX,threads.net,🚀 节点选择"'));

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
