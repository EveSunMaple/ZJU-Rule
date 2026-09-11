/**
 * Vercel Serverless Function：订阅转换接口。
 *
 * 默认使用项目内置的 JavaScript 转换引擎 —— 也就是说这个函数本身就是
 * 转换器，不需要任何外部服务就能跑。
 *
 * 如果确实需要 Surge / Quantumult X / sing-box 这些内置引擎不支持的格式，
 * 再配置环境变量 SUBCONVERTER_BACKEND 指向一个 subconverter 实例即可，
 * 那时这些 target 会自动转发过去。
 */

import { handleSub } from '../lib/handler.mjs';

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  const origin = `https://${req.headers.host || 'localhost'}`;

  let url;
  try {
    url = new URL(req.url, origin);
  } catch {
    res.status(400).send('无法解析请求 URL');
    return;
  }

  const result = await handleSub(url, {
    origin,
    // Vercel 上规则文件通过同源 CDN 获取，不走文件系统
    fsRoot: null,
    cacheKey: `vercel:${process.env.VERCEL_DEPLOYMENT_ID || 'dev'}`,
    subconverterBackend: process.env.SUBCONVERTER_BACKEND || '',
  });

  res.status(result.status);
  res.setHeader('Content-Type', result.contentType);
  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.send(result.body);
}
