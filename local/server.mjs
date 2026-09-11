#!/usr/bin/env node
/**
 * ZJU Rule 本地转换服务。
 *
 * 提供与原 zjurule.xyz 相同的功能：把机场订阅链接转换成使用 ZJU 分流规则的
 * Clash / Surge / Quantumult X 等订阅链接。
 *
 * 组成：
 *   1. 静态站点     —— 项目根目录（index.html + Clash/**.list 规则文件）
 *   2. 规则镜像     —— /Clash/config/*.ini 在返回前把规则源地址改写为当前站点地址，
 *                      这样整套规则完全自包含，不再依赖已失效的上游仓库
 *   3. subconverter —— 自动下载并托管 subconverter 后端（默认 127.0.0.1:25500）
 *   4. /sub 反向代理 —— 浏览器只需访问同源地址，避免 CORS 与混合内容问题
 *
 * 用法：
 *   node local/server.mjs                 # 默认 http://127.0.0.1:8080
 *   WEB_PORT=9000 node local/server.mjs
 *   node local/server.mjs --no-subconverter   # 只起静态站点（后端另配）
 */

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { rewriteBases } from '../lib/rule-urls.mjs';
import { buildRuleCatalog } from '../lib/catalog.mjs';
import { handleSub } from '../lib/handler.mjs';
import { buildPac } from '../lib/pac.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(__dirname, 'bin', 'subconverter');
const TMP_DIR = path.join(__dirname, 'tmp');
const SC_BINARY = path.join(BIN_DIR, 'subconverter');

const SC_VERSION = 'v0.9.0';
const SC_ASSETS = {
  arm64: 'subconverter_darwinarm.tar.gz',
  x64: 'subconverter_darwin64.tar.gz',
};

const argv = process.argv.slice(2);
const NO_SUBCONVERTER = argv.includes('--no-subconverter');
const WEB_PORT = Number(process.env.WEB_PORT || 8080);
const SUB_PORT = Number(process.env.SUB_PORT || 25500);
/** 浏览器/客户端访问本服务时使用的地址。默认本机。 */
const WEB_HOST = process.env.WEB_HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.list': 'text/plain; charset=utf-8',
  '.acl': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const log = (...args) => console.log('[zju-rule]', ...args);

/* ------------------------------------------------------------------ */
/* subconverter 生命周期                                                */
/* ------------------------------------------------------------------ */

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function archKey() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

/** 若本地没有 subconverter 二进制，则从 GitHub Releases 下载。 */
async function ensureSubconverter() {
  if (await exists(SC_BINARY)) return;

  const asset = SC_ASSETS[archKey()];
  const url = `https://github.com/tindy2013/subconverter/releases/download/${SC_VERSION}/${asset}`;
  const archive = path.join(TMP_DIR, asset);

  await mkdir(TMP_DIR, { recursive: true });
  log(`首次运行：正在下载 subconverter (${asset}) …`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载 subconverter 失败：HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(archive));

  log('正在解压 …');
  await rm(BIN_DIR, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });

  const tar = spawn('tar', ['xzf', archive, '-C', path.dirname(BIN_DIR)], {
    stdio: 'inherit',
  });
  await new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`)),
    );
  });

  // 归档解压后是 subconverter/ 目录，正好等于 BIN_DIR
  if (!(await exists(SC_BINARY))) throw new Error('解压后未找到 subconverter 可执行文件');
  log('subconverter 就绪。');
}

/** 生成 subconverter 的 pref.toml，并同步 Clash 基础配置。 */
async function prepareSubconverterConfig() {
  const baseDir = path.join(BIN_DIR, 'base');
  const rulesDir = path.join(BIN_DIR, 'rules');
  const profilesDir = path.join(BIN_DIR, 'profiles');
  await mkdir(baseDir, { recursive: true });
  await mkdir(rulesDir, { recursive: true });
  await mkdir(profilesDir, { recursive: true });

  // Clash 基础配置：使用项目自带的 GeneralClashConfig.yml（含 mixed-port、
  // allow-lan、external-controller 等 ZJU 相关设置），而不是 subconverter 的通用模板。
  await copyFile(
    path.join(ROOT, 'Clash', 'GeneralClashConfig.yml'),
    path.join(baseDir, 'ZJU_GeneralClashConfig.yml'),
  );

  const templatePath = path.join(BIN_DIR, 'pref.example.toml');
  let pref;
  if (await exists(templatePath)) {
    pref = await readFile(templatePath, 'utf8');
  } else {
    pref = 'version = 1\n[common]\n';
  }

  const setKey = (text, key, value) => {
    const re = new RegExp(`^(\\s*)#?\\s*${key}\\s*=.*$`, 'm');
    if (re.test(text)) return text.replace(re, `${key} = ${value}`);
    return `${text}\n${key} = ${value}\n`;
  };

  pref = setKey(pref, 'api_mode', 'false');
  pref = setKey(pref, 'base_path', '"base"');
  pref = setKey(pref, 'clash_rule_base', '"base/ZJU_GeneralClashConfig.yml"');
  pref = setKey(pref, 'enable_insert', 'false');
  // 默认模板会把「到期/剩余流量」等信息节点排除掉，保留该行为。
  pref = setKey(pref, 'exclude_remarks', '["(到期|剩余流量|官网|产品|发布|订阅|地址)"]');
  pref = setKey(pref, 'proxy_config', '"SYSTEM"');
  pref = setKey(pref, 'proxy_ruleset', '"SYSTEM"');

  await writeFile(path.join(BIN_DIR, 'pref.toml'), pref, 'utf8');
}

/** 启动 subconverter 子进程并等待端口就绪。 */
async function startSubconverter() {
  const logFile = path.join(TMP_DIR, 'subconverter.log');
  await mkdir(TMP_DIR, { recursive: true });
  const out = createWriteStream(logFile, { flags: 'a' });

  const child = spawn(SC_BINARY, [], { cwd: BIN_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) log(`⚠ subconverter 已退出 (code=${code} signal=${signal})，详见 ${logFile}`);
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`subconverter 启动失败，详见 ${logFile}`);
    try {
      const res = await fetch(`http://127.0.0.1:${SUB_PORT}/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        log(`subconverter 已启动 → http://127.0.0.1:${SUB_PORT}  (日志: ${logFile})`);
        return child;
      }
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待 subconverter 就绪超时，详见 ${logFile}`);
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                            */
/* ------------------------------------------------------------------ */

/** 读取并改写一个 ini 配置文件。 */
async function renderIni(relPath, origin) {
  const abs = path.join(ROOT, relPath);
  const raw = await readFile(abs, 'utf8');
  return rewriteBases(raw, `${origin}/`).text;
}

/** 列出可用的规则分组配置。 */
async function listProfiles() {
  const dir = path.join(ROOT, 'Clash', 'config');
  const entries = await readdir(dir);
  return entries
    .filter((n) => n.endsWith('.ini'))
    .sort()
    .map((name) => ({
      name,
      path: `/Clash/config/${name}`,
      zju: name === 'ZJU.ini',
    }))
    .sort((a, b) => Number(b.zju) - Number(a.zju) || a.name.localeCompare(b.name));
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

/**
 * 处理 /sub 请求。
 *
 * 默认走项目内置的 JavaScript 转换引擎（和 Vercel 上跑的是同一套代码），
 * 所以本地不需要 subconverter 也能完整转换。
 * 如果请求的 target 内置引擎不支持（Surge / QuantumX 等），
 * 且本地 subconverter 已经起来，就自动转发给它。
 */
async function handleSubRequest(req, res, url, origin) {
  const result = await handleSub(url, {
    origin,
    fsRoot: ROOT,
    cacheKey: 'local',
    subconverterBackend: NO_SUBCONVERTER ? '' : `http://127.0.0.1:${SUB_PORT}`,
  });

  const target = url.searchParams.get('target') || 'clash';
  const engine = result.headers?.['X-ZJU-Engine'] || '-';
  log(
    `转换 → target=${target} engine=${engine} ` +
      `nodes=${result.headers?.['X-ZJU-Nodes'] ?? '-'} rules=${result.headers?.['X-ZJU-Rules'] ?? '-'} ` +
      `status=${result.status}`,
  );

  const body = Buffer.from(result.body, 'utf8');
  res.writeHead(result.status, {
    'Content-Type': result.contentType,
    'Content-Length': body.length,
    ...(result.headers || {}),
  });
  res.end(body);
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const abs = path.normalize(path.join(ROOT, rel));
  // 防目录穿越
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(abs);
    if (info.isDirectory()) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(await readFile(abs));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 Not Found: ${rel}`);
  }
}

function createWebServer() {
  return http.createServer(async (req, res) => {
    const origin = `http://${req.headers.host || `${WEB_HOST}:${WEB_PORT}`}`;
    const url = new URL(req.url, origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      });
      res.end();
      return;
    }

    try {
      // 规则配置：返回前把规则源改写到当前站点，实现完全自包含
      if (url.pathname.startsWith('/Clash/config/') && url.pathname.endsWith('.ini')) {
        const body = await renderIni(url.pathname.slice(1), origin);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(body);
        return;
      }

      if (url.pathname === '/sub') return await handleSubRequest(req, res, url, origin);

      // 前端在加载时读取这份运行时配置（本地由本服务生成，Vercel 上由构建脚本生成）
      if (url.pathname === '/zju-config.js') {
        const payload = JSON.stringify({
          env: 'local',
          // 内置引擎随时可用，所以永远有转换能力
          engineAvailable: true,
          proxyAvailable: true,
          // 本地 subconverter 在的话，Surge / Quantumult X 这些格式也能转
          subconverterAvailable: !NO_SUBCONVERTER,
          origin,
          profiles: await listProfiles(),
        });
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(`window.__ZJU_CONFIG__ = ${payload};\n`);
        return;
      }

      // 规则集清单，给前端的「规则设置」面板用
      if (url.pathname === '/api/rules') {
        try {
          const catalog = await buildRuleCatalog(url.searchParams.get('config'), {
            origin,
            fsRoot: ROOT,
            cacheKey: 'local',
          });
          return sendJson(res, catalog.ok ? 200 : 404, catalog);
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      // PAC 文件：不开系统代理、只让浏览器走代理时用
      if (url.pathname === '/proxy.pac') {
        try {
          const { pac, stats } = await buildPac(
            {
              mode: url.searchParams.get('mode') || 'smart',
              proxy: url.searchParams.get('proxy') || '127.0.0.1:7890',
              extraDirect: (url.searchParams.get('direct') || '').split(',').filter(Boolean),
              extraProxy: (url.searchParams.get('proxy_domains') || '').split(',').filter(Boolean),
            },
            { origin, fsRoot: ROOT, cacheKey: 'local-pac' },
          );
          log(`生成 PAC（${stats.mode} 模式，${(stats.bytes / 1024).toFixed(0)} KB）`);
          res.writeHead(200, {
            'Content-Type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
            'Content-Length': Buffer.byteLength(pac, 'utf8'),
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(pac);
        } catch (err) {
          log(`✗ PAC 生成失败: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`PAC 生成失败：${err.message}`);
        }
        return;
      }

      if (url.pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          root: ROOT,
          engine: 'builtin',
          subconverter: NO_SUBCONVERTER ? null : `http://127.0.0.1:${SUB_PORT}`,
        });
      }

      return await serveStatic(req, res, url);
    } catch (err) {
      log(`✗ 请求处理失败 ${url.pathname}: ${err.stack || err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`500 Internal Server Error\n\n${err.message}`);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

let shuttingDown = false;
let scChild = null;

async function main() {
  log(`项目目录: ${ROOT}`);

  if (!NO_SUBCONVERTER) {
    await ensureSubconverter();
    await prepareSubconverterConfig();
  }

  const server = createWebServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(WEB_PORT, WEB_HOST, resolve);
  });
  log(`规则站点: http://${WEB_HOST}:${WEB_PORT}`);

  if (!NO_SUBCONVERTER) {
    scChild = await startSubconverter();
  } else {
    log('已跳过 subconverter（--no-subconverter）');
  }

  log('');
  log(`✅ 打开浏览器访问  http://${WEB_HOST}:${WEB_PORT}`);
  log('   把机场订阅链接粘进去，点「生成订阅链接」即可。');
  log('');

  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${sig}，正在关闭 …`);
    if (scChild && scChild.exitCode === null) scChild.kill('SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[zju-rule] ✗ 启动失败:', err.message);
  process.exit(1);
});
