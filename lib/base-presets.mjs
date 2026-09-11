/**
 * 可选的基础配置（Clash / Mihomo 的端口、DNS、嗅探等）。
 *
 * 这些文件在 configs/ 目录下。Vercel 上的 Serverless Function 没法列目录，
 * 所以这里维护一份清单；tools/test-journey.mjs 会校验清单和实际文件一致，
 * 不会悄悄漂移。
 */

export const BASE_PRESETS = [
  {
    id: 'default',
    path: '/configs/clash-base.yaml',
    name: '普通模式',
    short: '校外 / 家里',
    desc: '用阿里 DoH 等公共 DNS 解析，适合不在校园网内的场景。',
  },
  {
    id: 'campus',
    path: '/configs/clash-base-campus.yaml',
    name: '校园网模式',
    short: '宿舍 / 实验室 / ZJUWLAN',
    desc: '浙大域名改用校内 DNS (10.10.0.21) 解析，开着系统代理也能正常上内网。',
  },
];

/** 默认使用哪一个。 */
export const DEFAULT_BASE_ID = 'default';

/** 按 id 找路径。 */
export function basePathById(id) {
  return BASE_PRESETS.find((b) => b.id === id)?.path || null;
}
