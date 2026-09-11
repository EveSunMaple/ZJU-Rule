/**
 * 探测当前 mihomo 内核到底支持哪些规则类型。
 *
 *   node tools/probe-rule-types.mjs
 *
 * 为什么要这个工具：Mihomo 会随版本增删规则类型（比如 USER-AGENT 和 URL-REGEX
 * 在某个版本之后就不再支持了），而我们生成配置时必须在客户端加载之前把不支持的
 * 规则过滤掉，否则用户会看到「订阅配置校验失败」。
 *
 * 与其凭记忆维护一张表，不如直接问内核。lib/engine/clash.mjs 里的
 * MIHOMO_RULE_TYPES 就是靠这个工具逐个探测出来的。
 *
 * 升级 mihomo 版本后建议重跑一次，确认表还准确。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIHOMO_RULE_TYPES } from '../lib/engine/clash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIHOMO = path.join(ROOT, 'local', 'bin', 'mihomo');
const WORK = path.join(ROOT, 'local', 'tmp', 'probe');

/** 每个规则类型配一条最小可用的示例规则。 */
const SAMPLES = {
  DOMAIN: 'DOMAIN,www.example.com,DIRECT',
  'DOMAIN-SUFFIX': 'DOMAIN-SUFFIX,example.com,DIRECT',
  'DOMAIN-KEYWORD': 'DOMAIN-KEYWORD,example,DIRECT',
  'DOMAIN-REGEX': 'DOMAIN-REGEX,^ads\\.,DIRECT',
  GEOSITE: 'GEOSITE,category-ads-all,DIRECT',
  'IP-CIDR': 'IP-CIDR,10.0.0.0/8,DIRECT',
  'IP-CIDR6': 'IP-CIDR6,fc00::/7,DIRECT',
  'IP-SUFFIX': 'IP-SUFFIX,1.2.3.0/24,DIRECT',
  'SRC-IP-CIDR': 'SRC-IP-CIDR,192.168.1.0/24,DIRECT',
  'SRC-PORT': 'SRC-PORT,80,DIRECT',
  'DST-PORT': 'DST-PORT,443,DIRECT',
  'IN-PORT': 'IN-PORT,7890,DIRECT',
  'IN-TYPE': 'IN-TYPE,SOCKS5,DIRECT',
  'IN-USER': 'IN-USER,admin,DIRECT',
  'IN-NAME': 'IN-NAME,test,DIRECT',
  'PROCESS-NAME': 'PROCESS-NAME,Telegram,DIRECT',
  'PROCESS-PATH': 'PROCESS-PATH,/usr/bin/curl,DIRECT',
  'PROCESS-NAME-REGEX': 'PROCESS-NAME-REGEX,^Tele.*,DIRECT',
  'PROCESS-PATH-REGEX': 'PROCESS-PATH-REGEX,^/usr/.*,DIRECT',
  GEOIP: 'GEOIP,CN,DIRECT',
  'SRC-GEOIP': 'SRC-GEOIP,CN,DIRECT',
  NETWORK: 'NETWORK,udp,DIRECT',
  DSCP: 'DSCP,4,DIRECT',
  UID: 'UID,1000,DIRECT',
  'USER-AGENT': 'USER-AGENT,OneDrive*,DIRECT',
  'URL-REGEX': 'URL-REGEX,^https?://ads\\.example\\.com,DIRECT',
  'RULE-SET': 'RULE-SET,mySet,DIRECT',
  AND: 'AND,((NETWORK,udp),(DST-PORT,443)),DIRECT',
  OR: 'OR,((NETWORK,udp),(NETWORK,tcp)),DIRECT',
  NOT: 'NOT,((NETWORK,udp)),DIRECT',
  'SUB-RULE': 'SUB-RULE,(NETWORK,udp),DIRECT',
  MATCH: 'MATCH,DIRECT',
};

const BASE = `mixed-port: 7890
mode: rule
log-level: silent
proxies:
  - {name: "n1", type: ss, server: 1.2.3.4, port: 8388, cipher: aes-256-gcm, password: "pw"}
proxy-groups:
  - name: "G"
    type: select
    proxies: ["n1", "DIRECT"]
rule-providers:
  mySet:
    type: http
    behavior: domain
    url: "https://example.com/x.list"
    path: ./x.list
    interval: 86400
`;

if (!existsSync(MIHOMO)) {
  console.error(`✗ 找不到 mihomo：${MIHOMO}`);
  console.error('  跑一次 `node tools/test-mihomo.mjs` 会自动下载。');
  process.exit(2);
}

const version = execFileSync(MIHOMO, ['-v'], { encoding: 'utf8' }).split('\n')[0];
console.log(`\n内核：${version}\n`);

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });

const supported = [];
const unsupported = [];
const otherErrors = [];

for (const [name, rule] of Object.entries(SAMPLES)) {
  const file = path.join(WORK, 'config.yaml');
  await writeFile(file, `${BASE}rules:\n  - ${rule}\n`, 'utf8');

  try {
    execFileSync(MIHOMO, ['-t', '-d', WORK, '-f', file], { stdio: 'pipe' });
    supported.push(name);
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    if (/unsupported rule type/i.test(out)) unsupported.push(name);
    else {
      const line = out.split('\n').find((l) => l.includes('level=error')) || out.split('\n')[0];
      otherErrors.push(`${name}: ${line.replace(/^.*?msg=/, '').slice(0, 120)}`);
    }
  }
}

console.log(`✅ 内核支持 (${supported.length})：`);
console.log(`   ${supported.join(', ')}\n`);

if (unsupported.length) {
  console.log(`❌ 内核不支持 (${unsupported.length})：`);
  console.log(`   ${unsupported.join(', ')}\n`);
}

if (otherErrors.length) {
  console.log('⚠ 无法判定（示例写法或平台限制）：');
  for (const e of otherErrors) console.log(`   ${e}`);
  console.log('');
}

/* --- 和引擎里的表比对 --- */
const engineSet = MIHOMO_RULE_TYPES;
const missingInEngine = supported.filter((t) => !engineSet.has(t));
const extraInEngine = [...engineSet].filter((t) => !supported.includes(t));

console.log('与 lib/engine/clash.mjs 的 MIHOMO_RULE_TYPES 比对：');
if (!missingInEngine.length && !extraInEngine.length) {
  console.log('  ✅ 完全一致');
  process.exit(0);
}

if (missingInEngine.length) {
  console.log(`  ⚠ 内核支持但引擎没放行（会导致规则被误删）：${missingInEngine.join(', ')}`);
}
if (extraInEngine.length) {
  console.log(`  ⚠ 引擎放行但内核不支持（会导致客户端报错！）：${extraInEngine.join(', ')}`);
}
console.log('\n请更新 lib/engine/clash.mjs 里的 MIHOMO_RULE_TYPES。\n');
process.exit(1);
