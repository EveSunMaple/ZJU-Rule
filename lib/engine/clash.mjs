/**
 * Clash / Mihomo 配置生成。
 *
 * 输出策略：
 *   - proxies 用 flow 风格（一行一个节点，体积小、便于 diff）
 *   - proxy-groups 用 block 风格（可读性好）
 *   - rules 用 block 风格
 *   - 所有字符串一律加双引号，避免节点名/密码里的特殊字符把 YAML 弄坏
 */

import { yamlString } from './util.mjs';

/** 我们要接管、必须从 base 配置里剔除的顶层键。 */
const MANAGED_KEYS = ['proxies', 'proxy-groups', 'rules', 'Proxy', 'Proxy Group', 'Rule'];

/**
 * 从 base 配置文本里删掉 proxies / proxy-groups / rules 三个顶层块，
 * 剩下的原样保留（注释、DNS、端口等）。
 */
export function stripManagedKeys(yamlText) {
  const lines = String(yamlText || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let skipping = false;

  for (const line of lines) {
    const topLevel = /^([A-Za-z][A-Za-z0-9 _-]*)\s*:/.exec(line);

    if (topLevel) {
      const key = topLevel[1].trim();
      if (MANAGED_KEYS.includes(key)) {
        skipping = true;
        continue;
      }
      skipping = false;
    } else if (skipping) {
      // 顶层块内的缩进行 / 空行一律丢弃
      if (/^\s/.test(line) || !line.trim()) continue;
      skipping = false;
    }

    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** 把 JS 值渲染成 YAML flow 标量。 */
export function flowValue(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';

  if (Array.isArray(value)) {
    return `[${value.map(flowValue).join(', ')}]`;
  }

  if (typeof value === 'object') {
    const pairs = Object.entries(value)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${flowValue(v)}`);
    return `{${pairs.join(', ')}}`;
  }

  return yamlString(value);
}

/** 渲染一个节点为 flow 风格的一行。 */
export function renderProxy(node) {
  return `  - ${flowValue(node)}`;
}

/** 渲染策略组为 block 风格。 */
export function renderProxyGroup(group) {
  const lines = [`  - name: ${yamlString(group.name)}`, `    type: ${group.type}`];

  if (group.url) lines.push(`    url: ${yamlString(group.url)}`);
  if (group.interval) lines.push(`    interval: ${group.interval}`);
  if (group.tolerance) lines.push(`    tolerance: ${group.tolerance}`);
  if (group['lazy'] !== undefined) lines.push(`    lazy: ${group.lazy}`);
  if (group.strategy) lines.push(`    strategy: ${group.strategy}`);

  lines.push('    proxies:');
  for (const p of group.proxies) lines.push(`      - ${yamlString(p)}`);

  return lines.join('\n');
}

/** 渲染规则列表。 */
export function renderRules(rules, indent = '  ') {
  return rules.map((r) => `${indent}- ${yamlString(r)}`).join('\n');
}

/**
 * 生成最终的 Clash 配置文本。
 *
 * @param {object}   input
 * @param {string}   input.baseYaml 基础配置（不含 proxies/proxy-groups/rules）
 * @param {object[]} input.proxies
 * @param {object[]} input.groups
 * @param {string[]} input.rules
 * @returns {string}
 */
export function buildClashConfig({ baseYaml, proxies, groups, rules }) {
  const parts = [];

  const base = stripManagedKeys(baseYaml);
  if (base) parts.push(base);

  parts.push('');
  parts.push('# ===== 节点 =====');
  parts.push('proxies:');
  parts.push(...proxies.map(renderProxy));

  parts.push('');
  parts.push('# ===== 策略组 =====');
  parts.push('proxy-groups:');
  parts.push(...groups.map(renderProxyGroup));

  parts.push('');
  parts.push('# ===== 分流规则 =====');
  parts.push('rules:');
  parts.push(renderRules(rules));
  parts.push('');

  return parts.join('\n');
}

/**
 * 规则去重，保留首次出现的顺序。
 * 45k 条规则里有不少跨列表重复项，去重能显著减小订阅体积。
 */
export function dedupeRules(rules) {
  const seen = new Set();
  const out = [];
  for (const r of rules) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

/**
 * 把用户自定义规则转成 Clash 规则行。
 *
 * 支持三种写法：
 *   "example.com"                  → DOMAIN-SUFFIX,example.com,<策略>
 *   "DOMAIN,foo.com"               → 原样补上策略
 *   "IP-CIDR,1.2.3.0/24,no-resolve"→ 原样补上策略
 *
 * @param {Array<{rule: string, policy: string}>|string[]} custom
 * @param {string} defaultPolicy
 */
export function customRulesToClash(custom, defaultPolicy = '🚀 节点选择') {
  const out = [];

  for (const item of custom || []) {
    const raw = typeof item === 'string' ? item : item?.rule;
    const policy = (typeof item === 'string' ? defaultPolicy : item?.policy) || defaultPolicy;

    let line = String(raw || '').trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const parts = line.split(',').map((s) => s.trim()).filter(Boolean);

    // 纯域名 / IP → 自动补类型
    if (parts.length === 1) {
      let v = parts[0];
      // 同学常常写成 *.example.com，Clash 的 DOMAIN-SUFFIX 不需要这个前缀
      v = v.replace(/^\*\./, '.');
      if (/^\d{1,3}(\.\d{1,3}){3}\/\d+$/.test(v) || /^[0-9a-f:]+\/\d+$/i.test(v)) {
        out.push(`IP-CIDR,${v},${policy}`);
      } else if (v.startsWith('.')) {
        out.push(`DOMAIN-SUFFIX,${v.slice(1)},${policy}`);
      } else {
        out.push(`DOMAIN-SUFFIX,${v},${policy}`);
      }
      continue;
    }

    if (parts.length === 2) {
      out.push(`${parts[0].toUpperCase()},${parts[1]},${policy}`);
      continue;
    }

    // 三字段以上：最后一段是 no-resolve 之类的修饰符
    const last = parts[parts.length - 1].toLowerCase();
    if (last === 'no-resolve') {
      out.push(`${parts[0].toUpperCase()},${parts[1]},${policy},no-resolve`);
    } else {
      out.push(`${parts[0].toUpperCase()},${parts[1]},${policy}`);
    }
  }

  return out;
}
