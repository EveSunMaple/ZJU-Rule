#!/usr/bin/env node
/**
 * Vercel 构建脚本。
 *
 * 把仓库构建成一个「静态站点 + 可选 serverless 代理」：
 *
 *   public/index.html         转换界面
 *   public/zju-config.js      运行时配置（后端地址 / 规则列表）
 *   public/Clash/**           规则文件与 ZJU.ini 等配置（规则源已改写为本站地址）
 *   public/docs/**            文档图片
 *
 * 环境变量：
 *   RULES_BASE_URL          规则源前缀。默认使用部署域名（自包含）。
 *                           设为 "github" 则改用 GitHub raw 地址。
 *   SUBCONVERTER_BACKEND    subconverter 后端地址（可选）。设置后会启用
 *                           /sub 同源代理，浏览器无需跨域访问后端。
 */

import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_LIVE_BASE, rewriteBases } from '../lib/rule-urls.mjs';
import { buildPac } from '../lib/pac.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');

const log = (...a) => console.log('[build]', ...a);

/** 推导部署后的站点根地址。 */
function resolveDeployOrigin() {
  const explicit = process.env.SITE_URL || process.env.RULES_BASE_URL;
  if (explicit && /^https?:\/\//.test(explicit)) return explicit.replace(/\/+$/, '');

  // Vercel 提供的地址（生产域名优先，其次当前部署）
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (prod) return `https://${prod.replace(/\/+$/, '')}`;

  return null;
}

const rulesBaseEnv = process.env.RULES_BASE_URL || '';
let rulesBase;

if (rulesBaseEnv === 'github') {
  rulesBase = DEFAULT_LIVE_BASE;
} else {
  const origin = resolveDeployOrigin();
  rulesBase = origin ? `${origin}/` : DEFAULT_LIVE_BASE;
}

log(`规则源前缀: ${rulesBase}`);

/* ------------------------------------------------------------------ */
/* 1. 输出目录                                                          */
/* ------------------------------------------------------------------ */

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

/* ------------------------------------------------------------------ */
/* 2. 复制并改写规则文件                                                 */
/* ------------------------------------------------------------------ */

log('复制 Clash/ 规则文件 …');
await cp(path.join(ROOT, 'Clash'), path.join(OUT, 'Clash'), { recursive: true });

// 内置转换引擎使用的基础配置（Clash / Mihomo 的端口、DNS、嗅探等）
log('复制 configs/ 基础配置 …');
await cp(path.join(ROOT, 'configs'), path.join(OUT, 'configs'), { recursive: true });

let iniCount = 0;
let iniReplacements = 0;

const configDir = path.join(OUT, 'Clash', 'config');
for (const name of await readdir(configDir)) {
  if (!name.endsWith('.ini')) continue;
  const file = path.join(configDir, name);
  const raw = await readFile(file, 'utf8');
  const { text, replacements } = rewriteBases(raw, rulesBase);
  if (replacements === 0) continue;
  await writeFile(file, text, 'utf8');
  iniCount += 1;
  iniReplacements += replacements;
}
log(`改写 ${iniCount} 个 ini，共 ${iniReplacements} 处规则源地址`);

/* ------------------------------------------------------------------ */
/* 3.5 PAC 文件（不开系统代理时用）                                      */
/* ------------------------------------------------------------------ */

log('生成 PAC 文件 …');
for (const [mode, file] of [['smart', 'proxy.pac'], ['global', 'proxy-global.pac']]) {
  const { pac, stats } = await buildPac({ mode }, { fsRoot: ROOT, cacheKey: `build-${mode}` });
  await writeFile(path.join(OUT, file), pac, 'utf8');
  log(
    `  ${file}  ${(stats.bytes / 1024).toFixed(0)} KB  ` +
      `(${mode === 'smart' ? `代理名单 ${stats.proxyDomains} 个域名` : `国内直连 ${stats.directDomains} 个域名`})`,
  );
}

/* ------------------------------------------------------------------ */
/* 4. 静态页面                                                          */
/* ------------------------------------------------------------------ */

log('复制页面资源 …');
await cp(path.join(ROOT, 'index.html'), path.join(OUT, 'index.html'));

// 保留旧的 ACL4SSR 说明页与截图
await mkdir(path.join(OUT, 'docs'), { recursive: true });
await cp(path.join(ROOT, 'docs', 'clash.png'), path.join(OUT, 'docs', 'clash.png'));
await cp(path.join(ROOT, 'docs', 'acl4ssr-readme.html'), path.join(OUT, 'docs', 'acl4ssr-readme.html'));

/* ------------------------------------------------------------------ */
/* 4. 运行时配置                                                        */
/* ------------------------------------------------------------------ */

const profiles = (await readdir(configDir))
  .filter((n) => n.endsWith('.ini'))
  .sort()
  .map((name) => ({ name, path: `/Clash/config/${name}`, zju: name === 'ZJU.ini' }))
  .sort((a, b) => Number(b.zju) - Number(a.zju) || a.name.localeCompare(b.name));

const backend = (process.env.SUBCONVERTER_BACKEND || '').replace(/\/+$/, '');

const runtimeConfig = {
  env: 'vercel',
  // 内置 JavaScript 引擎随 Serverless Function 一起部署，永远可用
  engineAvailable: true,
  proxyAvailable: true,
  // 只有配置了 SUBCONVERTER_BACKEND 时，Surge / Quantumult X 等格式才可用
  subconverterAvailable: Boolean(backend),
  // 不注入 origin：前端始终以浏览器实际访问的 location.origin 为准
  profiles,
};

await writeFile(
  path.join(OUT, 'zju-config.js'),
  `window.__ZJU_CONFIG__ = ${JSON.stringify(runtimeConfig, null, 0)};\n`,
  'utf8',
);

log(
  `生成 zju-config.js（profile ${profiles.length} 个，内置引擎：启用，` +
    `subconverter 扩展格式：${backend ? '已启用' : '未启用'}）`,
);
log(`✅ 构建完成 → ${OUT}`);
