/**
 * 内置订阅转换引擎。
 *
 * 这是 subconverter 的纯 JavaScript 替代实现，让整站可以独立部署到 Vercel：
 * 不需要任何常驻后端、不需要 Docker、不需要外部服务。
 *
 * 流程：
 *   1. 读取并解析 .ini 规则配置
 *   2. 抓取机场订阅 → 解析成节点
 *   3. 过滤 / 重命名节点
 *   4. 按配置生成策略组
 *   5. 并行加载所有规则集，拼上策略组名
 *   6. 生成 Clash 配置（或 base64 节点列表）
 */

import {
  buildClashConfig,
  customRulesToClash,
  dedupeRules,
  filterUnsupportedRules,
} from './clash.mjs';
import { nodesToLinks } from './links.mjs';
import { parseSubscriptionContent } from './nodes.mjs';
import { parseProfile, resolveProxyGroups, BUILTIN_POLICIES } from './profile.mjs';
import { processNodes } from './rename.mjs';
import { loadRuleSet, normalizeRuleSource, readAsset } from './rules.mjs';

/** 默认使用的规则配置。 */
export const DEFAULT_PROFILE = '/Clash/config/ZJU.ini';

/** 默认使用的 Clash 基础配置。 */
export const DEFAULT_BASE = '/configs/clash-base.yaml';

/** 默认请求订阅时使用的 UA —— 大多数机场看到 Clash UA 会返回更完整的配置。 */
export const DEFAULT_UA = 'clash-verge/v2.2.3';

/** 内置引擎直接支持的 target。 */
export const SUPPORTED_TARGETS = new Set(['clash', 'clashr', 'mixed', 'v2ray', 'ss']);

/* ------------------------------------------------------------------ */
/* 订阅抓取                                                            */
/* ------------------------------------------------------------------ */

/** 多个订阅地址用 | 分隔。 */
export function splitSubscriptionUrls(input) {
  return String(input || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 抓取单个订阅。
 * 支持 http(s) URL，以及直接传 base64 / 明文链接内容。
 */
async function fetchSubscription(url, options) {
  if (!/^https?:\/\//i.test(url)) {
    // 不是 URL，那就当作用户直接贴进来的订阅内容处理
    return { content: url, via: 'inline' };
  }

  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeout || 25_000),
    headers: {
      'User-Agent': options.ua || DEFAULT_UA,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });

  if (!res.ok) {
    const err = new Error(`订阅抓取失败：HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return { content: await res.text(), via: url, userinfo: res.headers.get('subscription-userinfo') };
}

/* ------------------------------------------------------------------ */
/* 策略组裁剪                                                          */
/* ------------------------------------------------------------------ */

/**
 * 删掉成员为空的策略组，并把其它组里对它的引用一并去掉。
 *
 * 这一步很关键：机场里没有香港节点时，「🇭🇰 香港节点」组会是空的，
 * 而「🚀 节点选择」又引用了它 —— 直接输出会让 Clash 报错起不来。
 */
function pruneEmptyGroups(groups) {
  let list = groups.map((g) => ({ ...g, proxies: [...g.proxies] }));
  const removed = [];

  for (;;) {
    const emptied = list.filter((g) => g.proxies.length === 0);
    if (!emptied.length) break;

    const dead = new Set(emptied.map((g) => g.name));
    for (const name of dead) removed.push(name);

    list = list
      .filter((g) => !dead.has(g.name))
      .map((g) => ({ ...g, proxies: g.proxies.filter((p) => !dead.has(p)) }));
  }

  return { groups: list, removed };
}

/**
 * 把规则里指向「已被删掉的策略组」的策略改成兜底策略，
 * 否则 Clash 会因为没有这个策略组而拒绝启动。
 *
 * 注意：`no-resolve` 之类的修饰符不是策略，判断时要跳过。
 */
function remapRulePolicies(rules, groupNames, fallback) {
  const valid = new Set([...groupNames, ...BUILTIN_POLICIES]);
  let changed = 0;

  const out = rules.map((line) => {
    const parts = line.split(',');
    if (parts.length < 3) return line;

    const last = parts[parts.length - 1].trim();
    const policyIndex = last === 'no-resolve' ? parts.length - 2 : parts.length - 1;
    if (policyIndex < 2) return line;

    const policy = parts[policyIndex].trim();
    if (valid.has(policy) || valid.has(policy.toUpperCase())) return line;

    changed += 1;
    parts[policyIndex] = fallback;
    return parts.join(',');
  });

  return { rules: out, changed };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 执行一次转换。
 *
 * @param {object} request
 * @param {string} request.subUrl      机场订阅链接（多个用 | 分隔）
 * @param {string} [request.profile]   规则配置路径，默认 /Clash/config/ZJU.ini
 * @param {string} [request.target]    clash | mixed | v2ray | ss
 * @param {object} [request.options]   { udp, tfo, scv, emoji, appendType, sort, exclude, include, ua }
 * @param {Array}  [request.customRules] 自定义规则 [{rule, policy}] 或 ["example.com"]
 * @param {string[]} [request.disabledRuleSets] 要跳过的规则集（按源地址或策略组名匹配）
 * @param {object} ctx                 { origin, fsRoot, cacheKey }
 * @returns {Promise<{ body: string, contentType: string, meta: object }>}
 */
export async function convert(request, ctx = {}) {
  const options = request.options || {};
  const target = String(request.target || 'clash').toLowerCase();
  const warnings = [];

  if (!SUPPORTED_TARGETS.has(target)) {
    const err = new Error(
      `内置引擎不支持 target=${target}。支持的客户端：clash、clashr、mixed、v2ray、ss。` +
        `如需 Surge / Quantumult X 等格式，请配置 SUBCONVERTER_BACKEND。`,
    );
    err.code = 'UNSUPPORTED_TARGET';
    err.status = 501;
    throw err;
  }

  const subs = splitSubscriptionUrls(request.subUrl);
  if (!subs.length) {
    const err = new Error('缺少订阅链接（url 参数）');
    err.code = 'NO_SUBSCRIPTION';
    err.status = 400;
    throw err;
  }

  /* --- 1. 规则配置 --- */
  const profilePath = normalizeRuleSource(request.profile || DEFAULT_PROFILE, ctx.origin) || DEFAULT_PROFILE;
  const profileText = await readAsset(profilePath, ctx);
  if (profileText == null) {
    const err = new Error(`找不到规则配置：${profilePath}`);
    err.code = 'PROFILE_NOT_FOUND';
    throw err;
  }
  const profile = parseProfile(profileText);

  /* --- 2. 抓取订阅 --- */
  const fetched = await Promise.all(
    subs.map(async (url) => {
      try {
        return await fetchSubscription(url, options);
      } catch (err) {
        return { error: err.message, via: url };
      }
    }),
  );

  const userinfo = fetched.find((f) => f.userinfo)?.userinfo || null;
  const failures = fetched.filter((f) => f.error);
  for (const f of failures) warnings.push(`订阅抓取失败：${f.via} — ${f.error}`);

  const contents = fetched.filter((f) => !f.error);
  if (!contents.length) {
    const err = new Error(`所有订阅都抓取失败：\n${failures.map((f) => `  · ${f.via}: ${f.error}`).join('\n')}`);
    err.code = 'SUBSCRIPTION_FETCH_FAILED';
    err.status = 502;
    throw err;
  }

  /* --- 3. 解析节点 --- */
  const rawNodes = [];
  const formats = [];
  for (const item of contents) {
    const { nodes, format } = parseSubscriptionContent(item.content, {
      udp: options.udp !== false,
      tfo: Boolean(options.tfo),
      scv: Boolean(options.scv),
    });
    formats.push(format);
    rawNodes.push(...nodes);
  }

  if (!rawNodes.length) {
    const err = new Error(
      '订阅里没有解析出任何节点。请确认订阅链接有效，且返回的是 base64 节点列表、Clash 配置或明文链接列表。',
    );
    err.code = 'NO_NODES';
    err.status = 400;
    throw err;
  }

  const nodes = processNodes(rawNodes, {
    exclude: options.exclude,
    include: options.include,
    emoji: options.emoji !== false,
    appendType: Boolean(options.appendType),
    sort: Boolean(options.sort),
  });

  if (!nodes.length) {
    const err = new Error('节点全部被过滤规则排除掉了，请检查「排除节点」正则。');
    err.code = 'ALL_NODES_FILTERED';
    err.status = 400;
    throw err;
  }

  /* --- 4. 策略组 --- */
  const resolvedGroups = resolveProxyGroups(profile.groups, nodes);
  const { groups, removed } = pruneEmptyGroups(resolvedGroups);
  if (removed.length) {
    warnings.push(`这些策略组因为没有匹配到节点被移除：${removed.join('、')}`);
  }

  // 兜底策略：优先用「节点选择」，没有就用第一个可用策略组
  const fallbackPolicy =
    groups.find((g) => g.name === '🚀 节点选择')?.name || groups[0]?.name || 'DIRECT';

  /* --- 5. 规则 --- */
  const disabled = new Set(request.disabledRuleSets || []);
  const activeRuleSets = profile.rulesets.filter(
    (rs) => !disabled.has(rs.source) && !disabled.has(rs.group),
  );

  // 并行加载，但限制并发数，避免把同源 CDN 打爆
  const CONCURRENCY = 8;
  const loaded = [];
  for (let i = 0; i < activeRuleSets.length; i += CONCURRENCY) {
    const batch = activeRuleSets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (rs) => {
        // [] 开头的是直接写死的规则，不用读文件
        if (rs.source.startsWith('[]')) {
          return { group: rs.group, literal: rs.source.slice(2), ok: true, via: 'inline' };
        }
        const res = await loadRuleSet(rs.source, rs.group, ctx);
        return { group: rs.group, ...res };
      }),
    );
    loaded.push(...results);
  }

  const rules = [];
  let fileRuleSets = 0;
  let loadedRuleSets = 0;

  for (const item of loaded) {
    if (!item.literal) fileRuleSets += 1;

    if (!item.ok) {
      warnings.push(`规则集加载失败：${item.via}（策略组 ${item.group}）`);
      continue;
    }
    if (!item.literal) loadedRuleSets += 1;

    if (item.literal) {
      // []FINAL → MATCH,<策略组>；其它（如 []GEOIP,CN）直接补上策略组
      const lit = item.literal.trim();
      if (/^FINAL$/i.test(lit)) rules.push(`MATCH,${item.group}`);
      else rules.push(`${lit},${item.group}`);
      continue;
    }
    rules.push(...item.rules);
  }

  // 所有规则文件都加载失败 = 配置基本是废的。
  // 这种情况必须报错，不能静默产出一份「能加载但完全不分流」的配置。
  if (fileRuleSets > 0 && loadedRuleSets === 0) {
    const failed = loaded.filter((i) => !i.ok && !i.literal).slice(0, 5);
    const err = new Error(
      `规则文件全部加载失败（共 ${fileRuleSets} 个），生成的配置不会有任何分流效果。\n` +
        `常见原因：规则配置里写的是相对路径，但站点上没有对应的规则文件。\n` +
        `失败的规则集：\n${failed.map((i) => `  · ${i.via}`).join('\n')}`,
    );
    err.code = 'ALL_RULESETS_FAILED';
    err.status = 500;
    throw err;
  }

  if (fileRuleSets > 0 && loadedRuleSets < fileRuleSets) {
    warnings.push(
      `有 ${fileRuleSets - loadedRuleSets} / ${fileRuleSets} 个规则集没能加载，这部分分流会缺失。`,
    );
  }

  // 自定义规则放在最前面，优先级最高
  const custom = customRulesToClash(request.customRules, request.customRulesPolicy || fallbackPolicy);
  const allRules = dedupeRules([...custom, ...rules]);

  const remapped = remapRulePolicies(allRules, groups.map((g) => g.name), 'DIRECT');

  // 规则文件里混着 Mihomo 不支持的规则类型（USER-AGENT / URL-REGEX 等），
  // 留着会让 Clash 直接拒绝加载整份配置，所以必须过滤掉。
  const filtered = filterUnsupportedRules(remapped.rules);
  for (const d of filtered.dropped) {
    warnings.push(
      `已过滤 ${d.count} 条 Mihomo 不支持的 ${d.type} 规则` +
        `（例如 ${d.samples[0]?.slice(0, 60) || ''}）。这些是上游给 Surge / Clash Premium 写的写法，` +
        `删掉不影响同名域名规则继续生效。`,
    );
  }

  /* --- 6. 输出 --- */
  const meta = {
    engine: 'builtin',
    target,
    nodeCount: nodes.length,
    groupCount: groups.length,
    ruleCount: filtered.rules.length,
    droppedUnsupportedRules: filtered.dropped.reduce((n, d) => n + d.count, 0),
    customRuleCount: custom.length,
    formats,
    profile: profilePath,
    warnings,
    userinfo,
    skippedRuleSets: [...disabled],
  };

  if (target === 'mixed' || target === 'v2ray' || target === 'ss') {
    const { encoded, skipped } = nodesToLinks(nodes);
    if (skipped.length) {
      warnings.push(`以下协议无法转成分享链接，已跳过：${[...new Set(skipped)].join('、')}。建议改用 Clash 客户端。`);
    }
    return {
      body: encoded,
      contentType: 'text/plain; charset=utf-8',
      meta: { ...meta, engine: 'builtin', output: 'links' },
    };
  }

  /* --- Clash 配置 --- */
  // 基础配置的选择优先级：
  //   1. 请求里显式指定的 base（前端「使用场景」选择器会给）
  //   2. 规则配置 ini 里写的 clash_rule_base
  //   3. 默认的 configs/clash-base.yaml
  const basePath = request.base
    ? normalizeRuleSource(request.base, ctx.origin)
    : profile.base.clash
      ? normalizeRuleSource(profile.base.clash, ctx.origin)
      : DEFAULT_BASE;
  let baseYaml = basePath ? await readAsset(basePath, ctx) : null;

  if (baseYaml == null) {
    warnings.push(`找不到基础配置 ${basePath}，已使用引擎内置的精简基础配置。`);
    baseYaml = [
      'mixed-port: 7890',
      'allow-lan: true',
      'mode: rule',
      'log-level: info',
      'external-controller: 127.0.0.1:9090',
    ].join('\n');
  }

  const body = buildClashConfig({
    baseYaml,
    proxies: nodes,
    groups,
    rules: filtered.rules,
  });

  return {
    body,
    contentType: 'text/yaml; charset=utf-8',
    meta: { ...meta, output: 'clash', remappedRules: remapped.changed },
    // buildClashConfig 用过滤后的规则

  };
}

export { parseProfile, parseSubscriptionContent, processNodes };
