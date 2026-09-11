/**
 * 规则集清单（catalog）。
 *
 * 给前端「规则设置」面板用：列出当前规则配置里用到的所有规则集，
 * 同学可以据此勾选要启用哪些、关掉哪些。
 */

import { DEFAULT_PROFILE } from './engine/index.mjs';
import { parseProfile } from './engine/profile.mjs';
import { normalizeRuleSource, readAsset } from './engine/rules.mjs';

/**
 * @param {string} [profilePath] 形如 /Clash/config/ZJU.ini
 * @param {object} ctx { origin, fsRoot, cacheKey }
 */
export async function buildRuleCatalog(profilePath, ctx = {}) {
  const path = normalizeRuleSource(profilePath || DEFAULT_PROFILE, ctx.origin) || DEFAULT_PROFILE;
  const text = await readAsset(path, ctx);

  if (text == null) {
    return { ok: false, error: `找不到规则配置：${path}`, profile: path, ruleSets: [], groups: [] };
  }

  const profile = parseProfile(text);

  const ruleSets = profile.rulesets.map((rs, index) => {
    const rel = normalizeRuleSource(rs.source, ctx.origin);
    const isInline = rs.source.startsWith('[]');
    const fileName = isInline ? rs.source.slice(2) : (rel || rs.source).split('/').pop();

    return {
      index,
      policy: rs.group,
      source: rs.source,
      path: rel,
      name: fileName.replace(/\.list$/i, ''),
      inline: isInline,
      // 体积特别大的规则集标记出来，方便同学判断该关掉哪个
      heavy: /BanEasyList|BanEasyPrivacy/i.test(rs.source),
    };
  });

  return {
    ok: true,
    profile: path,
    ruleSets,
    groups: profile.groups.map((g) => ({ name: g.name, type: g.type })),
  };
}
