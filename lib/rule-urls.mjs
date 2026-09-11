/**
 * 规则源地址的统一处理逻辑。
 *
 * 被三处复用：
 *   - tools/fix-rule-urls.mjs   （批量修复仓库内的配置文件）
 *   - local/server.mjs          （本地运行时动态改写到 localhost）
 *   - scripts/vercel-build.mjs  （Vercel 构建时改写到部署域名）
 */

/**
 * 已失效、必须被改写的规则源前缀。
 * `ZJU-Rule/ZJU-Rule` 仓库已删除，`zjurule.xyz` 站点已下线。
 */
export const DEAD_BASE_URLS = [
  'https://raw.githubusercontent.com/ZJU-Rule/ZJU-Rule/master/',
  'https://raw.githubusercontent.com/ZJU-Rule/ZJU-Rule/main/',
  'https://raw.gitmirror.com/ZJU-Rule/ZJU-Rule/master/',
  'https://ghproxy.com/https://raw.githubusercontent.com/ZJU-Rule/ZJU-Rule/master/',
  'https://zjurule.xyz/',
  'https://www.zjurule.xyz/',
];

/** 当前仍然可用的规则源（用户自己的仓库）。 */
export const DEFAULT_LIVE_BASE = 'https://raw.githubusercontent.com/lizhist/ZJU-Rule/master/';

/** 可以安全地就地替换为「当前部署地址」的规则源前缀。 */
export const REWRITABLE_BASE_URLS = [
  ...DEAD_BASE_URLS,
  DEFAULT_LIVE_BASE,
  'https://raw.githubusercontent.com/lizhist/ZJU-Rule/main/',
  'https://cdn.jsdelivr.net/gh/lizhist/ZJU-Rule@master/',
  'https://cdn.jsdelivr.net/gh/ZJU-Rule/ZJU-Rule@master/',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把文本中所有「已失效 / 可改写」的规则源前缀替换为 `base`。
 *
 * @param {string} text 原始文本
 * @param {string} base 目标前缀，必须以 `/` 结尾
 * @returns {{ text: string, replacements: number }}
 */
export function rewriteBases(text, base) {
  const target = base.endsWith('/') ? base : `${base}/`;
  let replacements = 0;
  let out = text;

  for (const from of REWRITABLE_BASE_URLS) {
    const re = new RegExp(escapeRe(from), 'g');
    const hits = out.match(re);
    if (!hits) continue;
    replacements += hits.length;
    out = out.replace(re, target);
  }

  return { text: out, replacements };
}

/**
 * 统计文本中仍然存在的失效链接数量。
 *
 * @param {string} text
 * @returns {number}
 */
export function countDeadUrls(text) {
  let count = 0;
  for (const dead of DEAD_BASE_URLS) {
    const re = new RegExp(escapeRe(dead), 'g');
    count += (text.match(re) || []).length;
  }
  return count;
}
