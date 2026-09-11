/**
 * /sub 请求的统一处理逻辑。
 *
 * 本地服务和 Vercel Serverless 都调用这里，保证两边行为完全一致。
 *
 * 参数（尽量兼容 subconverter，方便老链接直接换域名就能用）：
 *   url      机场订阅链接，多个用 | 分隔（必填）
 *   target   客户端类型，默认 clash
 *   config   规则配置，可以是 /Clash/config/ZJU.ini 或完整 URL
 *   udp/tfo/scv/emoji/append_type/sort   功能开关
 *   exclude / include                    节点名过滤正则
 *   custom   base64(JSON) 自定义规则 [{rule, policy}]
 *   disable  base64(JSON) 要跳过的规则集来源列表
 *   engine   builtin | subconverter，默认自动选择
 */

import { SUPPORTED_TARGETS, convert } from './engine/index.mjs';
import { base64Decode } from './engine/util.mjs';

/** 从查询串里读布尔值。 */
function boolParam(params, name, defaultValue) {
  if (!params.has(name)) return defaultValue;
  const v = String(params.get(name) || '').toLowerCase();
  if (v === '' || v === 'true' || v === '1' || v === 'yes') return true;
  return false;
}

/** 解析 base64(JSON) 参数。 */
function jsonParam(params, name, fallback) {
  const raw = params.get(name);
  if (!raw) return fallback;
  try {
    const decoded = base64Decode(raw) ?? raw;
    const value = JSON.parse(decoded);
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** 把请求参数翻译成引擎的入参。 */
export function parseRequest(url) {
  const params = url.searchParams;

  return {
    target: (params.get('target') || 'clash').toLowerCase(),
    subUrl: params.get('url') || params.get('sub') || '',
    profile: params.get('config') || params.get('profile') || undefined,
    engine: (params.get('engine') || '').toLowerCase(),
    customRules: jsonParam(params, 'custom', []),
    customRulesPolicy: params.get('custom_policy') || undefined,
    disabledRuleSets: jsonParam(params, 'disable', []),
    options: {
      udp: boolParam(params, 'udp', true),
      tfo: boolParam(params, 'tfo', false),
      scv: boolParam(params, 'scv', true),
      emoji: boolParam(params, 'emoji', true),
      appendType: boolParam(params, 'append_type', false),
      sort: boolParam(params, 'sort', false),
      exclude: params.get('exclude') || undefined,
      include: params.get('include') || undefined,
      ua: params.get('ua') || undefined,
    },
  };
}

/** 判断某个 target 是否必须走 subconverter。 */
export function needsSubconverter(target) {
  return !SUPPORTED_TARGETS.has(String(target || 'clash').toLowerCase());
}

/**
 * 处理一次 /sub 请求。
 *
 * @param {URL} url
 * @param {object} ctx { origin, fsRoot, cacheKey, subconverterBackend }
 * @returns {Promise<{ status:number, body:string, contentType:string, headers:object }>}
 */
export async function handleSub(url, ctx = {}) {
  let request;
  try {
    request = parseRequest(url);
  } catch (err) {
    return error(400, '请求参数解析失败', err.message);
  }

  if (!request.subUrl) {
    return error(400, '缺少订阅链接', '请在链接里带上 url 参数，例如 /sub?url=<你的机场订阅>');
  }

  const backend = (ctx.subconverterBackend || '').replace(/\/+$/, '');

  // 决定用哪个引擎
  let engine = request.engine;
  if (!engine) {
    if (needsSubconverter(request.target) && backend) engine = 'subconverter';
    else engine = 'builtin';
  }

  if (engine === 'subconverter') {
    if (!backend) {
      return error(
        501,
        '需要 subconverter 后端',
        `target=${request.target} 内置引擎不支持。请在环境变量里配置 SUBCONVERTER_BACKEND，` +
          `或改用 target=clash（内置引擎支持：${[...SUPPORTED_TARGETS].join('、')}）。`,
      );
    }
    return proxyToSubconverter(url, backend, ctx);
  }

  try {
    const result = await convert(request, ctx);
    return {
      status: 200,
      body: result.body,
      contentType: result.contentType,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-ZJU-Engine': 'builtin',
        'X-ZJU-Nodes': String(result.meta.nodeCount),
        'X-ZJU-Rules': String(result.meta.ruleCount),
        'X-ZJU-Groups': String(result.meta.groupCount),
        ...(result.meta.userinfo ? { 'subscription-userinfo': result.meta.userinfo } : {}),
        ...(result.meta.warnings?.length
          ? { 'X-ZJU-Warnings': encodeURIComponent(result.meta.warnings.join(' | ')).slice(0, 900) }
          : {}),
      },
    };
  } catch (err) {
    return error(err.status || 500, err.message, err.code ? `错误代码：${err.code}` : '');
  }
}

/** 转发给真正的 subconverter。 */
async function proxyToSubconverter(url, backend, ctx) {
  const params = new URLSearchParams(url.search);

  // config 传的是站内相对路径时，补成绝对地址，方便后端抓取
  const cfg = params.get('config');
  if (cfg && cfg.startsWith('/') && ctx.origin) {
    params.set('config', `${ctx.origin.replace(/\/+$/, '')}${cfg}`);
  }
  if (!params.has('target')) params.set('target', 'clash');

  try {
    const res = await fetch(`${backend}/sub?${params.toString()}`, {
      signal: AbortSignal.timeout(55_000),
      headers: { 'User-Agent': 'zju-rule/1.0' },
    });
    return {
      status: res.status,
      body: await res.text(),
      contentType: res.headers.get('content-type') || 'text/plain; charset=utf-8',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-ZJU-Engine': 'subconverter',
        ...(res.headers.get('subscription-userinfo')
          ? { 'subscription-userinfo': res.headers.get('subscription-userinfo') }
          : {}),
      },
    };
  } catch (err) {
    return error(502, '无法连接 subconverter 后端', `${backend} — ${err.message}`);
  }
}

function error(status, message, hint = '') {
  return {
    status,
    contentType: 'text/plain; charset=utf-8',
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    body: `❌ ${message}\n${hint ? `\n${hint}\n` : ''}`,
  };
}
