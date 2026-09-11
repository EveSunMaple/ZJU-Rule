/**
 * 校园网分流诊断工具。
 *
 *   node tools/diagnose.mjs cc98.org jw.zju.edu.cn www.baidu.com google.com
 *   node tools/diagnose.mjs --scene campus cc98.org
 *   node tools/diagnose.mjs --config ~/Downloads/config.yaml cc98.org
 *
 * 对每个域名回答四个问题：
 *   1. 系统 DNS 把它解析成什么（是不是内网 IP）
 *   2. 生成的配置里，第一条命中的规则是哪条
 *   3. 那条规则指向哪个策略组
 *   4. 那个策略组最终是直连还是走代理
 *
 * 「校内网站上不去 / 变慢」基本都能靠这个定位：
 *   - 解析失败或解析到外网 IP  → DNS 问题
 *   - 命中规则指向了代理节点    → 规则问题
 *   - 一切正常但还是慢          → 流量确实经过了 Clash，考虑加系统代理绕过
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convert } from '../lib/engine/index.mjs';
import { parseGeneratedConfig } from './validate-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SUB = `http://127.0.0.1:8080/local/tmp/engine-demo.txt`;

/* ---------------------------- 参数 ---------------------------- */

const argv = process.argv.slice(2);
const domains = [];
let scene = 'campus';
let subUrl = DEFAULT_SUB;
let configFile = null;

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--scene') scene = argv[++i];
  else if (a === '--sub') subUrl = argv[++i];
  else if (a === '--config') configFile = argv[++i];
  else if (a.startsWith('--')) {
    console.error(`未知参数：${a}`);
    process.exit(2);
  } else domains.push(a);
}

/* ---------------------------- 工具函数 ---------------------------- */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[36m',
};

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function inCidr(ip, cidr) {
  const [net, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const a = ipToInt(ip);
  const b = ipToInt(net);
  if (a === null || b === null || Number.isNaN(bits)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function isPrivateIp(ip) {
  return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8',
    '169.254.0.0/16', '100.64.0.0/10'].some((c) => inCidr(ip, c));
}

/** 用系统解析器查 A 记录。 */
function resolveSystem(host) {
  try {
    const out = execFileSync('dig', ['+short', '+time=3', '+tries=1', host, 'A'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ips = out.split('\n').map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));
    return ips.length ? ips : null;
  } catch {
    return null;
  }
}

/** 规则匹配（按列表顺序取第一条）。 */
function matchRule(rule, host, ip) {
  const parts = rule.split(',');
  const type = parts[0].trim().toUpperCase();
  const value = (parts[1] || '').trim().toLowerCase();

  switch (type) {
    case 'DOMAIN':
      return host === value;
    case 'DOMAIN-SUFFIX':
      return host === value || host.endsWith(`.${value}`);
    case 'DOMAIN-KEYWORD':
      return host.includes(value);
    case 'DOMAIN-REGEX':
      try { return new RegExp(parts[1], 'i').test(host); } catch { return false; }
    case 'IP-CIDR':
      return ip ? inCidr(ip, parts[1].trim()) : false;
    case 'IP-CIDR6':
      return false;
    case 'GEOIP':
      // 需要 GeoIP 数据库；这里只能粗略判断「内网 IP 不是 CN」
      return null;
    case 'MATCH':
      return true;
    default:
      return false;
  }
}

/** 顺着策略组找到最终出口：DIRECT / REJECT / 具体节点名。 */
function resolveExit(groups, name, depth = 0) {
  if (depth > 12) return { kind: 'loop', via: [] };
  const upper = String(name).toUpperCase();
  if (upper === 'DIRECT') return { kind: 'direct', via: [name] };
  if (upper === 'REJECT' || upper === 'REJECT-DROP') return { kind: 'reject', via: [name] };

  const g = groups.find((x) => x.name === name);
  if (!g) return { kind: 'node', via: [name] };
  if (!g.proxies.length) return { kind: 'empty', via: [name] };

  const first = g.proxies[0];
  const inner = resolveExit(groups, first, depth + 1);
  return { kind: inner.kind, via: [name, ...inner.via] };
}

/* ---------------------------- 主流程 ---------------------------- */

console.log(`\n${C.bold}ZJU Rule 分流诊断${C.reset}`);
console.log(`${C.dim}场景：${scene === 'campus' ? '校园网内' : '校外 / 家里'}${C.reset}\n`);

let configText;
if (configFile) {
  configText = readFileSync(configFile.replace(/^~/, process.env.HOME || ''), 'utf8');
  console.log(`${C.dim}分析已有配置：${configFile}${C.reset}\n`);
} else {
  const base = scene === 'campus'
    ? '/configs/clash-base-campus.yaml'
    : '/configs/clash-base.yaml';
  try {
    const res = await convert(
      { subUrl, target: 'clash', base },
      { origin: null, fsRoot: ROOT, cacheKey: `diag-${Date.now()}` },
    );
    configText = res.body;
    console.log(`${C.dim}已按「${scene === 'campus' ? '校园网内' : '校外'}」生成配置：` +
      `${res.meta.nodeCount} 节点 / ${res.meta.groupCount} 策略组 / ${res.meta.ruleCount} 规则${C.reset}\n`);
  } catch (err) {
    console.error(`${C.red}生成配置失败：${err.message}${C.reset}`);
    console.error('提示：本地服务需要先跑起来（npm start）。或者用 --config 指定一个配置文件。');
    process.exit(1);
  }
}

const { proxies, groups, rules } = parseGeneratedConfig(configText);

// 检查 DNS 配置
const dnsEnabled = /^dns:\s*$/m.test(configText) && !/^dns:\s*\n\s*enable:\s*false/m.test(configText);
if (!configFile) {
  console.log(`${C.bold}DNS 模式${C.reset}`);
  if (!dnsEnabled) {
    console.log(`  ${C.green}✓${C.reset} Clash 不接管 DNS，直连域名交给系统解析器`);
    console.log(`    ${C.dim}→ 校内域名会拿到和「不开代理」时完全一样的地址${C.reset}`);
  } else {
    console.log(`  ${C.yellow}!${C.reset} Clash 自己解析 DNS`);
    const policy = /nameserver-policy:/.test(configText);
    console.log(`    ${policy ? '配了 nameserver-policy' : C.yellow + '没有配 nameserver-policy' + C.reset}`);
  }
  console.log(`  ${C.dim}策略组 ${groups.length} 个 · 节点 ${proxies.length} 个${C.reset}\n`);
}

if (!domains.length) {
  console.log(`${C.dim}用法：node tools/diagnose.mjs <域名> [域名...] [--scene campus|default]${C.reset}`);
  console.log(`${C.dim}例如：node tools/diagnose.mjs cc98.org jw.zju.edu.cn google.com${C.reset}\n`);
  process.exit(0);
}

console.log(`${C.bold}逐个域名诊断${C.reset}\n`);

for (const host of domains) {
  const h = host.toLowerCase();
  console.log(`${C.bold}${h}${C.reset}`);

  // 1) 系统 DNS
  const ips = resolveSystem(h);
  let ip = null;
  if (!ips) {
    console.log(`  ${C.yellow}?${C.reset} 系统 DNS 解析失败`);
  } else {
    ip = ips[0];
    const priv = isPrivateIp(ip);
    console.log(`  ${C.green}✓${C.reset} 系统 DNS → ${ips.join(', ')}` +
      (priv ? ` ${C.blue}(内网地址)${C.reset}` : ''));
  }

  // 2) 命中规则
  let hit = null;
  for (const rule of rules) {
    const m = matchRule(rule, h, ip);
    if (m === true) { hit = rule; break; }
  }

  if (!hit) {
    console.log(`  ${C.yellow}?${C.reset} 没有规则命中（理论上不该发生，最后应该有 MATCH 兜底）`);
    console.log('');
    continue;
  }

  const parts = hit.split(',');
  const policy = parts[parts.length - 1].trim() === 'no-resolve'
    ? parts[parts.length - 2].trim()
    : parts[parts.length - 1].trim();

  console.log(`  ${C.green}✓${C.reset} 命中规则：${C.dim}${hit}${C.reset}`);

  // 3) 策略组 → 出口
  const exit = resolveExit(groups, policy);
  const chain = exit.via.join(' → ');
  console.log(`  ${C.green}✓${C.reset} 策略组链路：${C.dim}${chain}${C.reset}`);

  if (exit.kind === 'direct') {
    console.log(`  ${C.green}${C.bold}→ 直连${C.reset}`);
  } else if (exit.kind === 'reject') {
    console.log(`  ${C.yellow}${C.bold}→ 被拦截 (REJECT)${C.reset}`);
  } else if (exit.kind === 'node') {
    console.log(`  ${C.red}${C.bold}→ 走代理节点${C.reset} ${C.dim}(${chain})${C.reset}`);
    if (/zju|cc98|zjusec/i.test(h)) {
      console.log(`  ${C.red}⚠ 这是校内域名，不应该走代理！${C.reset}`);
    }
  } else {
    console.log(`  ${C.yellow}→ 策略组为空 (${exit.kind})${C.reset}`);
  }
  console.log('');
}

console.log(`${C.dim}说明：本工具按规则顺序取第一条命中（近似 Mihomo 行为）。` +
  `GEOIP 这类需要 IP 数据库的规则无法在这里判断。${C.reset}\n`);
