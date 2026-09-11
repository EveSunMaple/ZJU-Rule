/**
 * ACL4SSR 风格 .ini 配置解析。
 *
 * 这就是仓库里 Clash/config/*.ini 使用的格式，也是 subconverter 的格式，
 * 所以同一份配置既能被内置引擎使用，也能被 subconverter 使用 —— 同学只需要
 * 学一种写法。
 *
 * 格式速览：
 *
 *   [custom]
 *   ; 规则集：策略组名,规则文件地址
 *   ruleset=✔ ZJU内网,https://raw.githubusercontent.com/.../Clash/ZJU.list
 *   ; 直接写死的规则（[] 前缀）
 *   ruleset=🎯 全球直连,[]GEOIP,CN
 *   ruleset=🐟 漏网之鱼,[]FINAL
 *
 *   ; 策略组：名字`类型`参数...
 *   custom_proxy_group=🚀 节点选择`select`[]♻️ 自动选择`[]DIRECT
 *   custom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`300,,50
 */

/** 内置策略名，Clash 允许直接引用。 */
const BUILTIN_POLICIES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);

/** 解析 .ini 文本。 */
export function parseProfile(iniText) {
  const rulesets = [];
  const groups = [];
  const base = {};

  for (const rawLine of String(iniText || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!value) continue;

    if (key === 'ruleset') {
      const comma = value.indexOf(',');
      if (comma < 0) continue;
      const group = value.slice(0, comma).trim();
      const source = value.slice(comma + 1).trim();
      if (group && source) rulesets.push({ group, source });
      continue;
    }

    if (key === 'custom_proxy_group') {
      const parsed = parseProxyGroup(value);
      if (parsed) groups.push(parsed);
      continue;
    }

    if (key === 'clash_rule_base' || key === 'singbox_rule_base') {
      base.clash = value;
    }
  }

  return { rulesets, groups, base };
}

/**
 * 解析一条 custom_proxy_group。
 *
 *   名字`类型`参数1`参数2...
 *
 * select 类型的所有参数都是成员（`[]字面量` 或正则）。
 * url-test / fallback / load-balance 的第一个参数是筛选正则，
 * 之后是测速地址与间隔。
 */
export function parseProxyGroup(value) {
  const parts = value.split('`').map((s) => s.trim());
  if (parts.length < 2) return null;

  const name = parts[0];
  const type = parts[1].toLowerCase();
  if (!name || !type) return null;

  const args = parts.slice(2);
  const group = { name, type, filters: [], members: [] };

  const isTestType = type === 'url-test' || type === 'fallback' || type === 'load-balance' || type === 'relay';
  const looksLikeUrl = (s) => /^https?:\/\//i.test(s || '');

  if (isTestType) {
    let filterArgs = args;
    let url;
    let opts;

    if (args.length >= 3 && looksLikeUrl(args[1])) {
      filterArgs = [args[0]];
      url = args[1];
      opts = args[2];
    } else if (args.length >= 2 && looksLikeUrl(args[0])) {
      filterArgs = [];
      url = args[0];
      opts = args[1];
    } else if (args.length >= 1 && looksLikeUrl(args[0])) {
      filterArgs = [];
      url = args[0];
    }

    group.url = url || 'http://www.gstatic.com/generate_204';
    group.filters = filterArgs.filter((a) => a && !a.startsWith('[]'));
    group.members = filterArgs.filter((a) => a.startsWith('[]')).map((a) => a.slice(2));

    if (opts) {
      const [interval, , tolerance] = opts.split(',');
      if (interval && Number.parseInt(interval, 10) > 0) group.interval = Number.parseInt(interval, 10);
      if (tolerance && Number.parseInt(tolerance, 10) > 0) group.tolerance = Number.parseInt(tolerance, 10);
    }
  } else {
    for (const arg of args) {
      if (!arg) continue;
      if (arg.startsWith('[]')) group.members.push(arg.slice(2));
      else group.filters.push(arg);
    }
  }

  return group;
}

/**
 * 把解析出来的策略组展开成 Clash 的 proxy-groups。
 *
 * @param {object[]} groups  parseProfile 的结果
 * @param {object[]} nodes   已解析的节点
 * @param {object}   options { extraMembers?: Record<string,string[]>, dropEmpty?: boolean }
 * @returns {object[]} Clash proxy-groups
 */
export function resolveProxyGroups(groups, nodes, options = {}) {
  const nodeNames = nodes.map((n) => n.name);
  const groupNames = new Set(groups.map((g) => g.name));
  const extra = options.extraMembers || {};

  // 先算出每个组的成员，再统一过滤掉不存在的引用
  const resolved = groups.map((g) => {
    const members = [];

    for (const literal of g.members) members.push(literal);

    for (const pattern of g.filters) {
      let re;
      try {
        re = new RegExp(pattern);
      } catch {
        continue;
      }
      for (const name of nodeNames) {
        if (re.test(name)) members.push(name);
      }
    }

    if (extra[g.name]) members.unshift(...extra[g.name]);

    const out = {
      name: g.name,
      type: g.type,
    };
    if (g.type === 'url-test' || g.type === 'fallback' || g.type === 'load-balance') {
      out.url = g.url || 'http://www.gstatic.com/generate_204';
      out.interval = g.interval || 300;
      out.tolerance = g.tolerance || 50;
    }

    out._members = dedupe(members);
    return out;
  });

  // 过滤无效引用：策略组引用了不存在的东西会让 Clash 直接报错
  for (const g of resolved) {
    const valid = g._members.filter(
      (m) => BUILTIN_POLICIES.has(String(m).toUpperCase()) || groupNames.has(m) || nodeNames.includes(m),
    );
    g.proxies = dedupe(valid);
  }

  const result = resolved
    .filter((g) => g.proxies.length > 0 || !options.dropEmpty)
    .map((g) => {
      const { _members, ...rest } = g;
      return rest;
    });

  return result;
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const key = String(x);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

/**
 * 找出配置里引用了但没定义的策略组名，方便给出友好提示。
 * （通常是因为节点名不匹配导致的正则没命中，不算错误。）
 */
export function findUndefinedGroups(profile) {
  const defined = new Set(profile.groups.map((g) => g.name));
  const referenced = new Set();

  for (const rs of profile.rulesets) referenced.add(rs.group);
  for (const g of profile.groups) {
    for (const m of g.members) referenced.add(m);
  }

  return [...referenced].filter((name) => !defined.has(name) && !BUILTIN_POLICIES.has(name.toUpperCase()));
}

export { BUILTIN_POLICIES };
