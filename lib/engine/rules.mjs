/**
 * 规则集加载与解析。
 *
 * 规则文件沿用 ACL4SSR 的 .list 格式：每行 `类型,值[,no-resolve]`，
 * 注释以 # 或 ; 开头。文件里**不含**策略组名，策略由 ini 里的
 * `ruleset=策略组,文件` 决定。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { REWRITABLE_BASE_URLS } from '../rule-urls.mjs';

/** 模块级缓存：warm 的 Serverless 实例可以复用，避免重复下载。 */
const fileCache = new Map();

/**
 * 把规则源地址归一化成站内相对路径。
 *
 *   https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/Clash/ZJU.list
 *   https://xxx.vercel.app/Clash/ZJU.list
 *   https://某个预览部署.vercel.app/Clash/ZJU.list
 *   /Clash/ZJU.list
 *      → 都归一化成 /Clash/ZJU.list
 *
 * 关键点：**不能**假设部署域名等于构建时的域名。Vercel 的预览部署、自定义域名、
 * 以及本地反代都会用不同的 origin 访问同一个站点，所以这里按「路径长什么样」
 * 来判断，而不是按域名。
 *
 * 归一化不了（真正的第三方规则）则返回 null，交给 HTTP 直接抓取。
 */
export function normalizeRuleSource(source, origin) {
  const s = String(source || '').trim();
  if (!s) return null;

  // 已经是站内相对路径
  if (s.startsWith('/')) return s;

  // 站点自己的资源：只看路径，不看域名
  try {
    const u = new URL(s);
    if (/^\/(Clash|configs)\//.test(u.pathname)) return u.pathname;
  } catch {
    /* 不是合法 URL，继续往下试 */
  }

  // 兜底：按已知的规则源前缀剥离
  for (const base of REWRITABLE_BASE_URLS) {
    if (s.startsWith(base)) return `/${s.slice(base.length)}`;
  }

  if (origin) {
    const o = origin.replace(/\/+$/, '');
    if (s.startsWith(`${o}/`)) return s.slice(o.length);
  }

  return null;
}

/** 去掉一行规则里的注释与空白。 */
function cleanLine(line) {
  let s = line.trim();
  if (!s || s.startsWith('#') || s.startsWith(';') || s.startsWith('//')) return null;
  // 行尾注释（只在没有 URL 的情况下安全处理）
  const hash = s.indexOf(' #');
  if (hash > 0) s = s.slice(0, hash).trim();
  return s || null;
}

/**
 * 读取一个站点内的资源文件（规则文件、ini 配置、基础配置都用它）。
 * 优先读本地文件，读不到再走 HTTP（Vercel 上就是同源 CDN）。
 *
 * @param {string} relPath 形如 /Clash/ZJU.list
 * @param {{ origin?: string, fsRoot?: string, cacheKey?: string }} ctx
 * @returns {Promise<string|null>}
 */
export async function readAsset(relPath, ctx) {
  const key = `${ctx.cacheKey || ''}${relPath}`;
  if (fileCache.has(key)) return fileCache.get(key);

  let text = null;

  if (ctx.fsRoot) {
    try {
      text = await readFile(path.join(ctx.fsRoot, relPath.replace(/^\//, '')), 'utf8');
    } catch {
      text = null;
    }
  }

  if (text == null && ctx.origin) {
    try {
      const res = await fetch(`${ctx.origin.replace(/\/+$/, '')}${relPath}`, {
        signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': 'zju-rule-engine' },
      });
      if (res.ok) text = await res.text();
    } catch {
      text = null;
    }
  }

  fileCache.set(key, text);
  return text;
}

/** 清空缓存（本地开发时文件改了可以调用）。 */
export function clearRuleCache() {
  fileCache.clear();
}

/**
 * 加载一个规则集，返回已经拼好策略组的 Clash 规则行。
 *
 * @param {string} source  规则源（URL 或站内路径）
 * @param {string} group   策略组名
 * @param {object} ctx     { origin, fsRoot, cacheKey }
 * @returns {Promise<{ rules: string[], ok: boolean, via: string }>}
 */
export async function loadRuleSet(source, group, ctx) {
  const relPath = normalizeRuleSource(source, ctx.origin);

  if (!relPath) {
    // 站外的第三方规则，直接抓
    try {
      const res = await fetch(source, {
        signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': 'zju-rule-engine' },
      });
      if (!res.ok) return { rules: [], ok: false, via: source };
      return { rules: toClashRules(await res.text(), group), ok: true, via: source };
    } catch {
      return { rules: [], ok: false, via: source };
    }
  }

  const text = await readAsset(relPath, ctx);
  if (text == null) return { rules: [], ok: false, via: relPath };

  return { rules: toClashRules(text, group), ok: true, via: relPath };
}

/**
 * 把 .list 文本转换成带策略组的 Clash 规则行。
 *
 *   DOMAIN-SUFFIX,zju.edu.cn          → DOMAIN-SUFFIX,zju.edu.cn,✔ ZJU内网
 *   IP-CIDR,10.0.0.0/8,no-resolve     → IP-CIDR,10.0.0.0/8,✔ ZJU内网,no-resolve
 */
export function toClashRules(text, group) {
  const out = [];

  for (const raw of String(text || '').split('\n')) {
    const line = cleanLine(raw);
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 2) continue;

    const type = parts[0].trim().toUpperCase();
    if (!type) continue;

    // 已经是完整规则（自带策略）的文件，跳过重写
    if (parts.length >= 3 && /^(DIRECT|REJECT|PROXY|PASS)$/i.test(parts[2].trim())) continue;

    if (parts.length >= 3 && parts[parts.length - 1].trim() === 'no-resolve') {
      out.push(`${parts[0].trim()},${parts[1].trim()},${group},no-resolve`);
    } else {
      out.push(`${parts[0].trim()},${parts[1].trim()},${group}`);
    }
  }

  return out;
}
