/**
 * Clash 配置校验器。
 *
 *   node tools/validate-config.mjs <config.yaml>
 *   curl -s "..." | node tools/validate-config.mjs -
 *
 * 检查生成的配置是不是「能被 Clash 正常加载」：
 *   - 策略组引用的节点 / 策略组都存在
 *   - 规则里的策略都存在
 *   - 每条规则格式合法
 *   - 节点关键字段齐全、端口合法
 *   - 最后一条是 MATCH 兜底
 *
 * 这类错误会让 Clash 直接拒绝启动，所以必须自动化检查。
 */

import { readFile } from 'node:fs/promises';

const BUILTIN_POLICIES = new Set([
  'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL',
]);

/** 允许出现在规则里的类型。 */
const RULE_TYPES = new Set([
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
  'GEOSITE', 'GEOIP', 'IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX', 'SRC-IP-CIDR',
  'SRC-PORT', 'DST-PORT', 'PROCESS-NAME', 'PROCESS-PATH',
  'USER-AGENT', 'URL-REGEX', 'NETWORK', 'MATCH', 'RULE-SET', 'SCRIPT',
  'IN-PORT', 'IN-TYPE', 'IN-USER', 'IN-NAME', 'SUB-RULE', 'AND', 'OR', 'NOT',
]);

/** 从 flow 风格的 `- {a: b, c: d}` 里取字段（够用即可）。 */
function flowFields(line) {
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end < 0) return null;

  const inner = line.slice(start + 1, end);
  const out = {};
  let depth = 0;
  let quote = null;
  let cur = '';

  const push = (chunk) => {
    const colon = chunk.indexOf(':');
    if (colon < 0) return;
    const k = chunk.slice(0, colon).trim().replace(/^"|"$/g, '');
    let v = chunk.slice(colon + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    out[k] = v;
  };

  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { push(cur); cur = ''; continue; }
    cur += ch;
  }
  push(cur);
  return out;
}

/** 解析生成的配置文本，抽出 proxies / proxy-groups / rules。 */
export function parseGeneratedConfig(text) {
  const lines = String(text).split('\n');
  const proxies = [];
  const groups = [];
  const rules = [];

  let section = null;
  let currentGroup = null;
  let inProxiesList = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    if (/^proxies:\s*$/.test(line)) { section = 'proxies'; currentGroup = null; inProxiesList = false; continue; }
    if (/^proxy-groups:\s*$/.test(line)) { section = 'groups'; currentGroup = null; inProxiesList = false; continue; }
    if (/^rules:\s*$/.test(line)) { section = 'rules'; currentGroup = null; inProxiesList = false; continue; }
    if (/^[A-Za-z][A-Za-z0-9 _-]*:/.test(line)) { section = null; currentGroup = null; inProxiesList = false; continue; }

    if (section === 'proxies') {
      const m = /^\s*-\s*(\{.*\})\s*$/.exec(line);
      if (m) proxies.push(flowFields(m[1]) || {});
      continue;
    }

    if (section === 'groups') {
      const name = /^\s*-\s*name:\s*"?([^"]*)"?\s*$/.exec(line);
      if (name) {
        currentGroup = { name: name[1], proxies: [], type: null, url: null, interval: null };
        groups.push(currentGroup);
        inProxiesList = false;
        continue;
      }
      if (!currentGroup) continue;

      const type = /^\s*type:\s*(\S+)\s*$/.exec(line);
      if (type) { currentGroup.type = type[1]; continue; }

      const url = /^\s*url:\s*"?([^"]*)"?\s*$/.exec(line);
      if (url) { currentGroup.url = url[1]; continue; }

      const interval = /^\s*interval:\s*(\d+)\s*$/.exec(line);
      if (interval) { currentGroup.interval = Number(interval[1]); continue; }

      if (/^\s*proxies:\s*$/.test(line)) { inProxiesList = true; continue; }

      if (inProxiesList) {
        const item = /^\s*-\s*(.*?)\s*$/.exec(line);
        if (item) {
          let v = item[1];
          if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
          currentGroup.proxies.push(v);
        }
      }
      continue;
    }

    if (section === 'rules') {
      const m = /^\s*-\s*"?(.*?)"?\s*$/.exec(line);
      if (m) rules.push(m[1].replace(/\\"/g, '"'));
    }
  }

  return { proxies, groups, rules };
}

/** 执行校验，返回问题列表。 */
export function validate(text) {
  const { proxies, groups, rules } = parseGeneratedConfig(text);
  const errors = [];
  const warnings = [];

  const nodeNames = new Set(proxies.map((p) => p.name));
  const groupNames = new Set(groups.map((g) => g.name));

  /* --- 节点 --- */
  if (!proxies.length) errors.push('没有任何节点');

  const seenNode = new Set();
  for (const p of proxies) {
    const label = p.name || '(未命名)';
    if (!p.name) errors.push('存在没有 name 的节点');
    if (seenNode.has(label)) errors.push(`节点名重复：${label}`);
    seenNode.add(label);

    for (const key of ['type', 'server', 'port']) {
      if (!p[key]) errors.push(`节点 "${label}" 缺少 ${key}`);
    }
    const port = Number(p.port);
    if (p.port && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      errors.push(`节点 "${label}" 端口非法：${p.port}`);
    }
    if (p.type === 'ss' && !p.cipher) errors.push(`节点 "${label}" 是 ss 但缺少 cipher`);
    if ((p.type === 'vmess' || p.type === 'vless') && !p.uuid) {
      errors.push(`节点 "${label}" 是 ${p.type} 但缺少 uuid`);
    }
    if ((p.type === 'trojan' || p.type === 'hysteria2') && !p.password) {
      errors.push(`节点 "${label}" 是 ${p.type} 但缺少 password`);
    }
  }

  /* --- 策略组 --- */
  if (!groups.length) errors.push('没有任何策略组');

  const seenGroup = new Set();
  for (const g of groups) {
    if (seenGroup.has(g.name)) errors.push(`策略组名重复：${g.name}`);
    seenGroup.add(g.name);

    if (!g.type) errors.push(`策略组 "${g.name}" 缺少 type`);
    if (!g.proxies.length) errors.push(`策略组 "${g.name}" 成员为空（Clash 会拒绝启动）`);

    for (const member of g.proxies) {
      if (BUILTIN_POLICIES.has(member.toUpperCase())) continue;
      if (groupNames.has(member)) continue;
      if (nodeNames.has(member)) continue;
      errors.push(`策略组 "${g.name}" 引用了不存在的成员：${member}`);
    }

    if (['url-test', 'fallback', 'load-balance'].includes(g.type)) {
      if (!g.url) warnings.push(`策略组 "${g.name}" 是 ${g.type} 但没有 url`);
      if (!g.interval) warnings.push(`策略组 "${g.name}" 是 ${g.type} 但没有 interval`);
    }
  }

  /* --- 规则 --- */
  if (!rules.length) errors.push('没有任何规则');

  let matchCount = 0;
  const seenRule = new Set();
  const dupes = [];

  for (const rule of rules) {
    const parts = rule.split(',');
    const type = parts[0].trim().toUpperCase();

    if (!RULE_TYPES.has(type)) {
      errors.push(`未知规则类型：${rule.slice(0, 80)}`);
      continue;
    }

    if (type === 'MATCH') {
      matchCount += 1;
      if (parts.length < 2) errors.push(`MATCH 规则缺少策略：${rule}`);
    } else if (parts.length < 3) {
      errors.push(`规则字段不足：${rule.slice(0, 80)}`);
    }

    if (seenRule.has(rule)) dupes.push(rule);
    seenRule.add(rule);

    const last = parts[parts.length - 1].trim();
    const policy = last === 'no-resolve' ? parts[parts.length - 2]?.trim() : last;

    if (!policy) {
      errors.push(`规则没有策略：${rule.slice(0, 80)}`);
      continue;
    }
    if (!BUILTIN_POLICIES.has(policy.toUpperCase()) && !groupNames.has(policy)) {
      errors.push(`规则引用了不存在的策略 "${policy}"：${rule.slice(0, 80)}`);
    }
  }

  if (matchCount === 0) errors.push('缺少 MATCH 兜底规则，未被匹配的流量会没有策略');
  if (matchCount > 1) warnings.push(`有 ${matchCount} 条 MATCH 规则，只有第一条会生效`);

  if (rules.length && !rules[rules.length - 1].trim().toUpperCase().startsWith('MATCH')) {
    warnings.push('MATCH 规则不在最后一条，后面的规则永远不会生效');
  }

  if (dupes.length) warnings.push(`有 ${dupes.length} 条重复规则（不影响功能，但会增大体积）`);

  return { errors, warnings, stats: { nodes: proxies.length, groups: groups.length, rules: rules.length } };
}

/* ------------------------------ CLI ------------------------------ */

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node tools/validate-config.mjs <config.yaml|->');
    process.exit(2);
  }

  let text;
  if (file === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    text = await readFile(file, 'utf8');
  }

  const { errors, warnings, stats } = validate(text);

  console.log(`节点 ${stats.nodes} 个 · 策略组 ${stats.groups} 个 · 规则 ${stats.rules} 条`);

  if (warnings.length) {
    console.log(`\n警告 ${warnings.length} 条：`);
    for (const w of warnings.slice(0, 10)) console.log(`  ⚠ ${w}`);
    if (warnings.length > 10) console.log(`  … 还有 ${warnings.length - 10} 条`);
  }

  if (errors.length) {
    console.log(`\n错误 ${errors.length} 条：`);
    for (const e of errors.slice(0, 20)) console.log(`  ✗ ${e}`);
    if (errors.length > 20) console.log(`  … 还有 ${errors.length - 20} 条`);
    console.log('\n❌ 配置校验未通过\n');
    process.exit(1);
  }

  console.log('\n✅ 配置校验通过\n');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
