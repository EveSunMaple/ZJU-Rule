/**
 * Vercel Serverless Function：给前端「规则设置」面板提供规则集清单。
 *
 * 返回当前规则配置里用到的所有规则集（策略组 + 文件），
 * 前端据此渲染勾选框，让同学可以按需关掉某些规则集。
 */

import { buildRuleCatalog } from '../lib/catalog.mjs';

export const config = {
  maxDuration: 30,
};

export default async function handler(req, res) {
  const origin = `https://${req.headers.host || 'localhost'}`;

  let url;
  try {
    url = new URL(req.url, origin);
  } catch {
    res.status(400).json({ ok: false, error: '无法解析请求 URL' });
    return;
  }

  try {
    const catalog = await buildRuleCatalog(url.searchParams.get('config'), {
      origin,
      fsRoot: null,
      cacheKey: `vercel:${process.env.VERCEL_DEPLOYMENT_ID || 'dev'}`,
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.status(catalog.ok ? 200 : 404).json(catalog);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
