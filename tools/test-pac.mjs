/**
 * PAC 文件测试。
 *
 *   node tools/test-pac.mjs
 *
 * 关键点：不是检查文本长什么样，而是把生成的 PAC **真的跑起来**，
 * 逐个域名问它「这个请求该走代理还是直连」，然后验证答案对不对。
 *
 * PAC 是一段 JS，浏览器会在每个请求上调用 FindProxyForURL，
 * 所以用 Node 的 vm 把它加载起来、补上 PAC 的内置函数即可完整测试。
 */

import vm from 'node:vm';

import { buildPac } from '../lib/pac.mjs';

const ctx = { origin: null, fsRoot: process.cwd(), cacheKey: `pac-${Date.now()}` };

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

/**
 * 把 PAC 加载成一个可调用的函数。
 * PAC 运行环境提供的内置函数在这里用等价实现补上。
 */
function loadPac(pacText) {
  const sandbox = {
    // --- PAC 标准内置函数 ---
    isPlainHostName: (host) => host.indexOf('.') === -1,
    dnsDomainIs: (host, domain) => host.length >= domain.length && host.slice(-domain.length) === domain,
    localHostOrDomainIs: (host, hostdom) => host === hostdom || hostdom.indexOf(host) === 0,
    isResolvable: () => true,
    isInNet: () => false,
    dnsResolve: () => '0.0.0.0',
    myIpAddress: () => '127.0.0.1',
    dnsDomainLevels: (host) => host.split('.').length - 1,
    shExpMatch: (str, pattern) =>
      new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(str),
    weekdayRange: () => true,
    dateRange: () => true,
    timeRange: () => true,
    Math,
    RegExp,
    parseInt,
    isNaN,
    String,
    console,
  };

  vm.createContext(sandbox);
  vm.runInContext(pacText, sandbox, { timeout: 5000 });

  if (typeof sandbox.FindProxyForURL !== 'function') {
    throw new Error('PAC 里没有定义 FindProxyForURL');
  }
  return sandbox.FindProxyForURL;
}

/** 判断一次查询的结果是直连还是代理。 */
function decide(fn, url, host) {
  const result = String(fn(url, host));
  if (result.startsWith('PROXY')) return 'proxy';
  if (result.startsWith('DIRECT')) return 'direct';
  return `other:${result}`;
}

console.log('\nPAC 测试\n');

/* ------------------------------------------------------------------ */
console.log('智能模式（默认：名单内走代理，其余直连）');

const smart = await buildPac({ mode: 'smart' }, ctx);
console.log(`  生成 ${(smart.stats.bytes / 1024).toFixed(0)} KB · ` +
  `浙大 ${smart.stats.zjuDomains} 个域名 · 代理名单 ${smart.stats.proxyDomains} 个域名\n`);

const f = loadPac(smart.pac);

check('zju.edu.cn 直连', decide(f, 'http://zju.edu.cn/', 'zju.edu.cn') === 'direct');
check('www.zju.edu.cn 直连', decide(f, 'https://www.zju.edu.cn/', 'www.zju.edu.cn') === 'direct');
check('内网子域 course.zju.edu.cn 直连', decide(f, 'https://course.zju.edu.cn/', 'course.zju.edu.cn') === 'direct');
check('cc98.org 直连', decide(f, 'https://cc98.org/', 'cc98.org') === 'direct');
check('www.cc98.org 直连', decide(f, 'https://www.cc98.org/', 'www.cc98.org') === 'direct');
check('zjusec.com 直连', decide(f, 'https://zjusec.com/', 'zjusec.com') === 'direct');
check('nexushd（关键词命中）直连', decide(f, 'https://nexushd.zju.edu.cn/', 'nexushd.zju.edu.cn') === 'direct');

check('内网 IP 10.1.2.3 直连', decide(f, 'http://10.1.2.3/', '10.1.2.3') === 'direct');
check('内网 IP 10.10.0.21 直连', decide(f, 'http://10.10.0.21/', '10.10.0.21') === 'direct');
check('192.168.x.x 直连', decide(f, 'http://192.168.1.1/', '192.168.1.1') === 'direct');
check('172.16.x.x 直连', decide(f, 'http://172.16.5.5/', '172.16.5.5') === 'direct');
check('127.0.0.1 直连', decide(f, 'http://127.0.0.1:8080/', '127.0.0.1') === 'direct');
check('localhost 直连', decide(f, 'http://localhost:3000/', 'localhost') === 'direct');
check('无域名主机名直连', decide(f, 'http://intranet/', 'intranet') === 'direct');

check('google.com 走代理', decide(f, 'https://google.com/', 'google.com') === 'proxy');
check('www.google.com 走代理', decide(f, 'https://www.google.com/', 'www.google.com') === 'proxy');
check('youtube.com 走代理', decide(f, 'https://youtube.com/', 'youtube.com') === 'proxy');
check('x.com 走代理', decide(f, 'https://x.com/', 'x.com') === 'proxy');
check('telegram.org 走代理', decide(f, 'https://telegram.org/', 'telegram.org') === 'proxy');

check('baidu.com 直连（智能模式省流量）', decide(f, 'https://baidu.com/', 'baidu.com') === 'direct');
check('taobao.com 直连', decide(f, 'https://taobao.com/', 'taobao.com') === 'direct');
check('同一个域名不同子域判断一致', 
  decide(f, 'https://a.b.c.google.com/', 'a.b.c.google.com') === 'proxy' &&
  decide(f, 'https://mail.google.com/', 'mail.google.com') === 'proxy');

check('不是 .cn 的国内站也直连（不在名单里）',
  decide(f, 'https://example-university.edu/', 'example-university.edu') === 'direct');

/* ------------------------------------------------------------------ */
console.log('\n全局模式（只有浙大和国内域名直连）');

const global = await buildPac({ mode: 'global' }, ctx);
console.log(`  生成 ${(global.stats.bytes / 1024).toFixed(0)} KB · ` +
  `国内直连名单 ${global.stats.directDomains} 个域名\n`);

const g = loadPac(global.pac);

check('zju.edu.cn 直连', decide(g, 'http://zju.edu.cn/', 'zju.edu.cn') === 'direct');
check('cc98.org 直连', decide(g, 'https://cc98.org/', 'cc98.org') === 'direct');
check('10.x 内网直连', decide(g, 'http://10.1.2.3/', '10.1.2.3') === 'direct');
check('baidu.com 直连', decide(g, 'https://baidu.com/', 'baidu.com') === 'direct');
check('taobao.com 直连', decide(g, 'https://taobao.com/', 'taobao.com') === 'direct');
check('google.com 走代理', decide(g, 'https://google.com/', 'google.com') === 'proxy');
check('github.com 走代理', decide(g, 'https://github.com/', 'github.com') === 'proxy');
check('陌生外国站也走代理', decide(g, 'https://some-obscure-foreign-site.com/', 'some-obscure-foreign-site.com') === 'proxy');

/* ------------------------------------------------------------------ */
console.log('\n两种模式的核心共同点');

for (const [name, fn] of [['智能模式', f], ['全局模式', g]]) {
  const critical = [
    ['zju.edu.cn', 'direct'],
    ['www.cc98.org', 'direct'],
    ['10.10.0.21', 'direct'],
    ['192.168.1.1', 'direct'],
    ['localhost', 'direct'],
  ];
  const allOk = critical.every(([host, want]) => decide(fn, `http://${host}/`, host) === want);
  check(`${name}：浙大内网 + 内网 IP 全部直连`, allOk);
}

/* ------------------------------------------------------------------ */
console.log('\n自定义');

const custom = await buildPac(
  { mode: 'smart', extraDirect: ['my-lab.example.edu'], extraProxy: ['my-blocked-site.com'] },
  ctx,
);
const c = loadPac(custom.pac);
check('自定义直连域名生效', decide(c, 'http://my-lab.example.edu/', 'my-lab.example.edu') === 'direct');
check('自定义代理域名生效', decide(c, 'http://my-blocked-site.com/', 'my-blocked-site.com') === 'proxy');

check('可以自定义代理端口', async () => {
  const p = await buildPac({ mode: 'smart', proxy: '127.0.0.1:7897' }, ctx);
  const fn = loadPac(p.pac);
  return String(fn('https://google.com/', 'google.com')).includes('127.0.0.1:7897');
});

/* ------------------------------------------------------------------ */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
