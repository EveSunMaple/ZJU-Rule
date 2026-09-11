/**
 * PAC 文件生成（Proxy Auto-Config）。
 *
 * 用场景：**不想开系统代理**，只想让浏览器走代理，其它软件（浙大客户端、
 * VPN、终端等）完全不受影响。
 *
 * 原理：浏览器把每个请求的域名交给 FindProxyForURL 判断，
 *   - 浙大域名 / 内网 IP → DIRECT（由系统 DNS 解析，校园网下天然正确）
 *   - 需要翻墙的域名     → 走本地 Clash 的 127.0.0.1:7890
 * 于是「外网能上、校内正常」。而且直连的域名根本不经过 Clash，
 * 也就不存在「Clash 拿公共 DNS 去解析内网域名」的问题。
 *
 * 两种模式：
 *   smart  智能模式（默认）：只有名单内的域名走代理，其余直连 —— 省流量
 *   global 全局模式：只有浙大和国内域名直连，其余全走代理 —— 更省心
 */

import { readAsset } from './engine/rules.mjs';

/** 读取一个规则文件并解析出各类条件。 */
async function loadConditions(relPath, ctx) {
  const text = await readAsset(relPath, ctx);

  const domains = new Set();
  const keywords = new Set();
  const cidrs = new Set();

  if (text == null) return { domains, keywords, cidrs, ok: false };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) continue;

    const parts = line.split(',');
    if (parts.length < 2) continue;

    const type = parts[0].trim().toUpperCase();
    const value = parts[1].trim();
    if (!value) continue;

    switch (type) {
      case 'DOMAIN-SUFFIX':
      case 'DOMAIN':
        domains.add(value.toLowerCase().replace(/^\./, ''));
        break;
      case 'DOMAIN-KEYWORD':
        keywords.add(value.toLowerCase());
        break;
      case 'IP-CIDR':
        if (!value.includes(':')) cidrs.add(value);
        break;
      default:
        break;
    }
  }

  return { domains, keywords, cidrs, ok: true };
}

/** 渲染成 PAC 里的对象字面量（用对象当哈希表，兼容性最好）。 */
function renderMap(name, set, indent = '  ') {
  const items = [...set].sort();
  if (!items.length) return `var ${name} = {};`;

  const lines = [];
  let line = indent;
  for (const item of items) {
    const piece = `${JSON.stringify(item)}:1,`;
    if (line.length + piece.length > 100) {
      lines.push(line);
      line = indent;
    }
    line += piece;
  }
  if (line.trim()) lines.push(line);

  return `var ${name} = {\n${lines.join('\n')}\n};`;
}

function renderArray(name, set) {
  const items = [...set].sort().map((s) => JSON.stringify(s));
  return `var ${name} = [${items.join(',')}];`;
}

/** 判断逻辑部分——与模式无关的公共代码。 */
const RUNTIME_HELPERS = `
/** host 是否命中域名表（含所有上级域名）。 */
function hitDomain(map, host) {
  var h = host;
  while (h) {
    if (map[h] === 1) return true;
    var i = h.indexOf('.');
    if (i < 0) return false;
    h = h.slice(i + 1);
  }
  return false;
}

/** host 是否包含任一关键词。 */
function hitKeyword(list, host) {
  for (var i = 0; i < list.length; i++) {
    if (host.indexOf(list[i]) >= 0) return true;
  }
  return false;
}

/** host 是不是 IPv4 字面量。 */
function isIpLiteral(host) {
  return /^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(host);
}

function ipToInt(ip) {
  var p = ip.split('.');
  return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + (+p[3]);
}

/** IP 是否落在某个 CIDR 里。 */
function inCidr(ip, cidr) {
  var slash = cidr.indexOf('/');
  if (slash < 0) return false;
  var net = cidr.slice(0, slash);
  var bits = parseInt(cidr.slice(slash + 1), 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;
  var mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(net) & mask);
}

function hitCidr(list, ip) {
  for (var i = 0; i < list.length; i++) {
    if (inCidr(ip, list[i])) return true;
  }
  return false;
}

/** 内网 / 保留地址：永远直连，绝不送进代理。 */
function isPrivateIp(ip) {
  return inCidr(ip, '10.0.0.0/8')
      || inCidr(ip, '172.16.0.0/12')
      || inCidr(ip, '192.168.0.0/16')
      || inCidr(ip, '127.0.0.0/8')
      || inCidr(ip, '169.254.0.0/16')
      || inCidr(ip, '100.64.0.0/10');
}
`;

/**
 * 生成 PAC 文本。
 *
 * @param {object} options
 * @param {'smart'|'global'} [options.mode]   模式
 * @param {string} [options.proxy]            本地代理地址，默认 127.0.0.1:7890
 * @param {string[]} [options.extraDirect]    额外直连的域名
 * @param {string[]} [options.extraProxy]     额外走代理的域名
 * @param {object} ctx                        { origin, fsRoot, cacheKey }
 * @returns {Promise<{ pac: string, stats: object }>}
 */
export async function buildPac(options = {}, ctx = {}) {
  const mode = options.mode === 'global' ? 'global' : 'smart';
  const proxy = options.proxy || '127.0.0.1:7890';

  // 浙大内网：永远直连
  const zju = await loadConditions('/Clash/ZJU.list', ctx);
  // 校园里另外几个需要校内 DNS 解析的域名
  for (const d of ['cc98.org', 'zjusec.com']) zju.domains.add(d);
  for (const extra of options.extraDirect || []) zju.domains.add(String(extra).toLowerCase());

  const empty = { domains: new Set(), keywords: new Set(), cidrs: new Set() };
  let proxySet = empty;
  let directSet = empty;

  if (mode === 'smart') {
    // 名单内走代理，其余直连（gfwlist 思路，最省流量）
    // 合并两个文件：ProxyGFWlist 是主体，ProxyExtra 补 gfwlist 停更后新出现的域名
    proxySet = await loadConditions('/Clash/ProxyGFWlist.list', ctx);
    const extra = await loadConditions('/Clash/ProxyExtra.list', ctx);
    for (const d of extra.domains) proxySet.domains.add(d);
    for (const k of extra.keywords) proxySet.keywords.add(k);
    for (const c of extra.cidrs) proxySet.cidrs.add(c);
  } else {
    // 只有国内域名直连，其余全走代理
    directSet = await loadConditions('/Clash/ChinaDomain.list', ctx);
  }

  for (const d of options.extraProxy || []) proxySet.domains.add(String(d).toLowerCase());

  // --- 组合 FindProxyForURL 的判断顺序 ---
  const lines = [];
  lines.push('function FindProxyForURL(url, host) {');
  lines.push("  host = String(host || '').toLowerCase();");
  lines.push('');
  lines.push('  // 1) 本机 / 没有域名的主机名 → 直连');
  lines.push("  if (!host || host === 'localhost' || isPlainHostName(host)) return DIRECT;");
  lines.push('');
  lines.push('  // 2) 浙大内网 → 直连。关键：不经过 Clash，DNS 由系统负责，');
  lines.push('  //    校园网环境下解析出来天然就是校内地址。');
  lines.push('  if (hitDomain(ZJU_DOMAINS, host)) return DIRECT;');
  lines.push('  if (ZJU_KEYWORDS.length && hitKeyword(ZJU_KEYWORDS, host)) return DIRECT;');
  lines.push('');
  lines.push('  // 3) IP 字面量');
  lines.push('  if (isIpLiteral(host)) {');
  lines.push('    if (isPrivateIp(host)) return DIRECT;');
  lines.push('    if (hitCidr(ZJU_CIDRS, host)) return DIRECT;');
  if (mode === 'smart') {
    lines.push('    if (hitCidr(PROXY_CIDRS, host)) return PROXY;');
  }
  lines.push('    return DIRECT;');
  lines.push('  }');
  lines.push('');
  lines.push('  // 4) 按域名判断');
  if (mode === 'smart') {
    lines.push('  if (hitDomain(PROXY_DOMAINS, host)) return PROXY;');
    lines.push('  if (PROXY_KEYWORDS.length && hitKeyword(PROXY_KEYWORDS, host)) return PROXY;');
    lines.push('  return DIRECT; // 不在名单里 → 直连，不浪费代理流量');
  } else {
    lines.push('  if (hitDomain(DIRECT_DOMAINS, host)) return DIRECT;');
    lines.push('  if (DIRECT_KEYWORDS.length && hitKeyword(DIRECT_KEYWORDS, host)) return DIRECT;');
    lines.push('  return PROXY; // 其余一律走代理');
  }
  lines.push('}');

  const pac = `// ===========================================================================
//  ZJU Rule · 浏览器自动代理配置 (PAC)
// ===========================================================================
//
//  用途：不开系统代理，只让浏览器按规则走代理，其它软件完全不受影响。
//        浙大域名走直连（由系统 DNS 解析，校园网下就是校内地址）。
//
//  怎么用：
//    1. 把它放到浏览器能访问的地址。本地服务已挂在：
//       http://127.0.0.1:8080/proxy.pac
//    2. 浏览器 / 系统设置里填「自动代理配置 URL」为该地址。
//       （Chrome 需要启动参数或系统设置；macOS 在 网络 → 代理 → 自动代理配置）
//    3. 保持 Clash 运行（提供 ${proxy} 这个本地端口），但**不要**打开系统代理开关。
//
//  模式：${mode === 'smart' ? '智能模式 —— 名单内的境外域名走代理，其余直连（省流量）' : '全局模式 —— 只有浙大和国内域名直连，其余走代理'}
//  代理：${proxy}
//  改端口的话，改下面的 PROXY 常量。
// ===========================================================================

var PROXY  = "PROXY ${proxy}; DIRECT";
var DIRECT = "DIRECT";

// ---- 浙大内网：一律直连 --------------------------------------------------
${renderMap('ZJU_DOMAINS', zju.domains)}
${renderArray('ZJU_KEYWORDS', zju.keywords)}
${renderArray('ZJU_CIDRS', zju.cidrs)}

// ---- ${mode === 'smart' ? '需要走代理的域名' : '国内直连域名'} ----------------------------------------------
${renderMap(mode === 'smart' ? 'PROXY_DOMAINS' : 'DIRECT_DOMAINS', mode === 'smart' ? proxySet.domains : directSet.domains)}
${renderArray(mode === 'smart' ? 'PROXY_KEYWORDS' : 'DIRECT_KEYWORDS', mode === 'smart' ? proxySet.keywords : directSet.keywords)}
${renderArray('PROXY_CIDRS', proxySet.cidrs)}

// ===========================================================================
//  判断逻辑，一般不需要改
// ===========================================================================
${RUNTIME_HELPERS}
${lines.join('\n')}
`;

  return {
    pac,
    stats: {
      mode,
      proxy,
      zjuDomains: zju.domains.size,
      proxyDomains: proxySet.domains.size,
      directDomains: directSet.domains.size,
      bytes: Buffer.byteLength(pac, 'utf8'),
    },
  };
}
