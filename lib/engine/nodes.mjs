/**
 * 订阅节点解析：把各种分享链接转换成 Clash / Mihomo 的 proxy 对象。
 *
 * 支持：ss / ssr / vmess / vless / trojan / hysteria2 / hysteria / tuic /
 *       socks5 / http(s)，以及 Clash YAML 订阅里的 proxies。
 *
 * 设计原则：任何一条链接解析失败都不应该影响其它节点，所以统一返回 null，
 * 由上层过滤掉。
 */

import {
  base64Decode,
  looksLikeBase64,
  parseQuery,
  parseRemark,
  stripRemark,
  toPort,
  unquote,
} from './util.mjs';

/** 统一给节点打上 udp / tfo 等公共开关。 */
function withCommon(node, opts) {
  if (!node) return null;
  if (opts.udp !== false) node.udp = true;
  if (opts.tfo) node.tfo = true;
  if (opts.scv) node['skip-cert-verify'] = true;
  return node;
}

/** 把 host:port 拆开，支持 IPv6 的 [::1]:443 写法。 */
function splitHostPort(str) {
  const s = String(str || '').trim();
  if (!s) return null;

  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return null;
    const host = s.slice(1, end);
    const rest = s.slice(end + 1);
    const port = rest.startsWith(':') ? toPort(rest.slice(1)) : 0;
    return host && port ? { host, port } : null;
  }

  const idx = s.lastIndexOf(':');
  if (idx < 0) return null;
  const host = s.slice(0, idx);
  const port = toPort(s.slice(idx + 1));
  return host && port ? { host, port } : null;
}

/** userinfo 可能是 base64，也可能是明文 method:password。 */
function splitUserInfo(raw) {
  if (!raw) return null;
  if (raw.includes(':')) {
    const i = raw.indexOf(':');
    return { user: raw.slice(0, i), pass: raw.slice(i + 1) };
  }
  const decoded = base64Decode(raw);
  if (!decoded) return null;
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/* ------------------------------------------------------------------ */
/* 各协议解析                                                          */
/* ------------------------------------------------------------------ */

/** ss:// SIP002 / 传统格式 / 明文格式。 */
function parseShadowsocks(link, opts) {
  let body = stripRemark(link.slice(5));

  let query = '';
  const qIdx = body.indexOf('?');
  if (qIdx >= 0) {
    query = body.slice(qIdx + 1);
    body = body.slice(0, qIdx);
  }

  let userInfo;
  let hostPort;

  const at = body.lastIndexOf('@');
  if (at >= 0) {
    userInfo = splitUserInfo(body.slice(0, at));
    hostPort = splitHostPort(body.slice(at + 1));
  } else {
    // 整个 body 是 base64(method:password@host:port)
    const decoded = base64Decode(body);
    if (!decoded) return null;
    const dAt = decoded.lastIndexOf('@');
    if (dAt < 0) return null;
    userInfo = splitUserInfo(decoded.slice(0, dAt));
    hostPort = splitHostPort(decoded.slice(dAt + 1));
  }

  if (!userInfo || !hostPort) return null;

  const node = {
    name: parseRemark(link) || `${hostPort.host}:${hostPort.port}`,
    type: 'ss',
    server: hostPort.host,
    port: hostPort.port,
    cipher: userInfo.user,
    password: userInfo.pass,
  };

  // 插件（obfs / v2ray-plugin）
  const q = parseQuery(query);
  if (q.plugin) {
    const parts = q.plugin.split(';');
    const pluginName = parts.shift();
    const pluginOpts = {};
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq < 0) pluginOpts[p] = true;
      else pluginOpts[p.slice(0, eq)] = p.slice(eq + 1);
    }
    if (pluginName === 'obfs-local' || pluginName === 'simple-obfs') {
      node.plugin = 'obfs';
      node['plugin-opts'] = {
        mode: pluginOpts.obfs || 'http',
        ...(pluginOpts['obfs-host'] ? { host: pluginOpts['obfs-host'] } : {}),
      };
    } else if (pluginName === 'v2ray-plugin') {
      node.plugin = 'v2ray-plugin';
      node['plugin-opts'] = {
        mode: pluginOpts.mode || 'websocket',
        ...(pluginOpts.host ? { host: pluginOpts.host } : {}),
        ...(pluginOpts.path ? { path: pluginOpts.path } : {}),
        ...(pluginOpts.tls ? { tls: true } : {}),
      };
    }
  }

  return withCommon(node, opts);
}

/** ssr://<base64> */
function parseShadowsocksR(link, opts) {
  const decoded = base64Decode(link.slice(6));
  if (!decoded) return null;

  // host:port:protocol:method:obfs:base64url(password)/?params
  const slash = decoded.indexOf('/?');
  const main = slash < 0 ? decoded.replace(/\/$/, '') : decoded.slice(0, slash);
  const params = slash < 0 ? '' : parseQuery(decoded.slice(slash + 2));

  const parts = main.split(':');
  if (parts.length < 6) return null;

  const password = base64Decode(parts[5]);
  if (password == null) return null;

  const hostPort = splitHostPort(`${parts[0]}:${parts[1]}`);
  if (!hostPort) return null;

  const remarkFromParams = params.remarks ? base64Decode(params.remarks) : null;

  return withCommon(
    {
      name: parseRemark(link) || remarkFromParams || hostPort.host,
      type: 'ssr',
      server: hostPort.host,
      port: hostPort.port,
      protocol: parts[2],
      cipher: parts[3],
      obfs: parts[4],
      password,
      ...(params.protoparam ? { 'protocol-param': base64Decode(params.protoparam) || '' } : {}),
      ...(params.obfsparam ? { 'obfs-param': base64Decode(params.obfsparam) || '' } : {}),
    },
    opts,
  );
}

/** 解析 ws / h2 / grpc / http 等传输层参数（vmess / vless / trojan 共用）。 */
function applyTransport(node, network, params) {
  const net = String(network || 'tcp').toLowerCase();

  switch (net) {
    case 'ws': {
      node.network = 'ws';
      node['ws-opts'] = {
        path: params.path || '/',
        ...(params.host ? { headers: { Host: params.host } } : {}),
      };
      break;
    }
    case 'h2':
    case 'http': {
      node.network = 'h2';
      node['h2-opts'] = {
        path: params.path || '/',
        ...(params.host ? { host: String(params.host).split(',') } : {}),
      };
      break;
    }
    case 'grpc': {
      node.network = 'grpc';
      node['grpc-opts'] = { 'grpc-service-name': params.serviceName || params.path || '' };
      break;
    }
    case 'tcp':
    default: {
      if (params.headerType === 'http') {
        node.network = 'http';
        node['http-opts'] = {
          path: [params.path || '/'],
          ...(params.host ? { headers: { Host: [params.host] } } : {}),
        };
      } else {
        node.network = 'tcp';
      }
      break;
    }
  }
  return node;
}

/** vmess://<base64(JSON)> */
function parseVmess(link, opts) {
  const decoded = base64Decode(link.slice(8));
  if (!decoded) return null;

  let json;
  try {
    json = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;

  const hostPort = splitHostPort(`${json.add}:${json.port}`);
  if (!hostPort || !json.id) return null;

  const tls = String(json.tls || '').toLowerCase();
  const node = {
    name: json.ps || hostPort.host,
    type: 'vmess',
    server: hostPort.host,
    port: hostPort.port,
    uuid: String(json.id),
    alterId: Number.parseInt(json.aid, 10) || 0,
    cipher: json.scy && json.scy !== 'auto' ? json.scy : 'auto',
  };

  if (tls === 'tls' || tls === 'reality' || tls === 'true') {
    node.tls = true;
    if (json.sni || json.host) node.servername = json.sni || String(json.host).split(',')[0];
  }
  if (json.fp) node['client-fingerprint'] = json.fp;
  if (json.alpn) node.alpn = String(json.alpn).split(',');

  applyTransport(node, json.net, {
    path: json.path,
    host: json.host,
    serviceName: json.path,
    headerType: json.type,
  });

  return withCommon(node, opts);
}

/** vless:// （也是 trojan 的解析基础，参数名基本一致） */
function parseVlessLike(link, type, opts) {
  const prefixLen = type === 'vless' ? 8 : 9; // 'vless://' or 'trojan://'
  const body = stripRemark(link.slice(prefixLen));

  const qIdx = body.indexOf('?');
  const main = qIdx < 0 ? body : body.slice(0, qIdx);
  const params = parseQuery(qIdx < 0 ? '' : body.slice(qIdx + 1));

  const at = main.lastIndexOf('@');
  if (at < 0) return null;

  const userInfo = main.slice(0, at);
  const hostPort = splitHostPort(main.slice(at + 1));
  if (!hostPort) return null;

  const node = {
    name: parseRemark(link) || hostPort.host,
    type,
    server: hostPort.host,
    port: hostPort.port,
  };

  if (type === 'vless') {
    node.uuid = userInfo;
    if (params.flow) node.flow = params.flow;
  } else {
    node.password = userInfo;
  }

  const security = String(params.security || '').toLowerCase();
  const insecure = params.allowInsecure === '1' || params.insecure === '1' || params.allowInsecure === 'true';

  if (security === 'tls') {
    node.tls = true;
    if (params.sni) node.servername = params.sni;
    if (insecure) node['skip-cert-verify'] = true;
    if (params.alpn) node.alpn = params.alpn.split(',');
    if (params.fp) node['client-fingerprint'] = params.fp;
  } else if (security === 'reality') {
    node.tls = true;
    if (params.sni) node.servername = params.sni;
    if (params.fp) node['client-fingerprint'] = params.fp;
    node['reality-opts'] = {
      ...(params.pbk ? { 'public-key': params.pbk } : {}),
      ...(params.sid ? { 'short-id': params.sid } : {}),
    };
  } else if (type === 'trojan') {
    // trojan 默认走 TLS
    node.tls = true;
    if (params.sni) node.sni = params.sni;
    else if (params.peer) node.sni = params.peer;
    if (insecure) node['skip-cert-verify'] = true;
  }

  applyTransport(node, params.type, {
    path: params.path,
    host: params.host,
    serviceName: params.serviceName,
  });

  // trojan 的 sn 字段名与 vless 不同，统一一下
  if (type === 'trojan' && node.servername) {
    node.sni = node.servername;
    delete node.servername;
  }

  return withCommon(node, opts);
}

/** hysteria2:// 与 hy2:// */
function parseHysteria2(link, opts) {
  const body = stripRemark(link.replace(/^(hysteria2|hy2):\/\//, ''));

  const qIdx = body.indexOf('?');
  const main = qIdx < 0 ? body : body.slice(0, qIdx);
  const params = parseQuery(qIdx < 0 ? '' : body.slice(qIdx + 1));

  const at = main.lastIndexOf('@');
  let password = '';
  let hostPart = main;

  if (at >= 0) {
    password = main.slice(0, at);
    hostPart = main.slice(at + 1);
  }

  // 也支持 hysteria2://host:port?auth=xxx 的写法
  if (!password && params.auth) password = params.auth;

  const hostPort = splitHostPort(hostPart);
  if (!hostPort) return null;

  const node = {
    name: parseRemark(link) || hostPort.host,
    type: 'hysteria2',
    server: hostPort.host,
    port: hostPort.port,
    password,
  };

  if (params.sni) node.sni = params.sni;
  else if (params.peer) node.sni = params.peer;
  if (params.insecure === '1' || params.allowInsecure === '1' || params.insecure === 'true') {
    node['skip-cert-verify'] = true;
  }
  if (params.obfs) {
    node.obfs = params.obfs;
    if (params['obfs-password']) node['obfs-password'] = params['obfs-password'];
  }
  if (params.alpn) node.alpn = params.alpn.split(',').filter(Boolean);

  return withCommon(node, opts);
}

/** hysteria://（v1） */
function parseHysteria(link, opts) {
  const body = stripRemark(link.slice(10)); // 'hysteria://'
  const qIdx = body.indexOf('?');
  const main = qIdx < 0 ? body : body.slice(0, qIdx);
  const params = parseQuery(qIdx < 0 ? '' : body.slice(qIdx + 1));

  const at = main.lastIndexOf('@');
  const hostPort = splitHostPort(at >= 0 ? main.slice(at + 1) : main);
  if (!hostPort) return null;

  const node = {
    name: parseRemark(link) || hostPort.host,
    type: 'hysteria',
    server: hostPort.host,
    port: hostPort.port,
  };

  if (params.auth) node['auth-str'] = params.auth;
  if (params.protocol) node.protocol = params.protocol;
  if (params.peer) node.sni = params.peer;
  if (params.upmbps) node.up = params.upmbps;
  if (params.downmbps) node.down = params.downmbps;
  if (params.insecure === '1' || params.insecure === 'true') node['skip-cert-verify'] = true;
  if (params.alpn) node.alpn = params.alpn.split(',').filter(Boolean);

  return withCommon(node, opts);
}

/** tuic:// */
function parseTuic(link, opts) {
  const body = stripRemark(link.slice(7)); // 'tuic://'
  const qIdx = body.indexOf('?');
  const main = qIdx < 0 ? body : body.slice(0, qIdx);
  const params = parseQuery(qIdx < 0 ? '' : body.slice(qIdx + 1));

  const at = main.lastIndexOf('@');
  if (at < 0) return null;

  const userInfo = main.slice(0, at);
  const hostPort = splitHostPort(main.slice(at + 1));
  if (!hostPort) return null;

  const [uuid, ...rest] = userInfo.split(':');
  const node = {
    name: parseRemark(link) || hostPort.host,
    type: 'tuic',
    server: hostPort.host,
    port: hostPort.port,
    uuid,
    ...(rest.length ? { password: rest.join(':') } : {}),
  };

  if (params.sni) node.sni = params.sni;
  if (params.congestion_control || params.congestion) {
    node['congestion-controller'] = params.congestion_control || params.congestion;
  }
  if (params.udp_relay_mode) node['udp-relay-mode'] = params.udp_relay_mode;
  if (params.alpn) node.alpn = params.alpn.split(',').filter(Boolean);
  if (params.allow_insecure === '1' || params.insecure === '1') node['skip-cert-verify'] = true;

  return withCommon(node, opts);
}

/** socks5:// socks:// http:// https:// */
function parseSocksOrHttp(link, opts) {
  const proto = link.slice(0, link.indexOf('://')).toLowerCase();
  const body = stripRemark(link.slice(link.indexOf('://') + 3));
  const at = body.lastIndexOf('@');

  let username;
  let password;
  let hostPart = body;

  if (at >= 0) {
    const userInfo = body.slice(0, at);
    hostPart = body.slice(at + 1);
    const colon = userInfo.indexOf(':');
    if (colon < 0) username = userInfo;
    else {
      username = userInfo.slice(0, colon);
      password = userInfo.slice(colon + 1);
    }
  }

  const hostPort = splitHostPort(hostPart.split('?')[0]);
  if (!hostPort) return null;

  const isHttp = proto === 'http' || proto === 'https';
  const node = {
    name: parseRemark(link) || hostPort.host,
    type: isHttp ? 'http' : 'socks5',
    server: hostPort.host,
    port: hostPort.port,
  };

  if (username) node.username = username;
  if (password) node.password = password;
  if (proto === 'https') node.tls = true;

  return withCommon(node, opts);
}

const SCHEME_HANDLERS = {
  ss: parseShadowsocks,
  ssr: parseShadowsocksR,
  vmess: parseVmess,
  vless: (link, opts) => parseVlessLike(link, 'vless', opts),
  trojan: (link, opts) => parseVlessLike(link, 'trojan', opts),
  hysteria2: parseHysteria2,
  hy2: parseHysteria2,
  hysteria: parseHysteria,
  tuic: parseTuic,
  socks5: parseSocksOrHttp,
  socks: parseSocksOrHttp,
  http: parseSocksOrHttp,
  https: parseSocksOrHttp,
};

/** 解析单条分享链接。解析不了返回 null。 */
export function parseShareLink(rawLink, opts = {}) {
  const link = String(rawLink || '').trim();
  if (!link) return null;

  const scheme = /^([a-zA-Z0-9]+):\/\//.exec(link);
  if (!scheme) return null;

  const handler = SCHEME_HANDLERS[scheme[1].toLowerCase()];
  if (!handler) return null;

  try {
    return handler(link, opts);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Clash YAML 订阅                                                      */
/* ------------------------------------------------------------------ */

/** 行内 flow 值（{a: 1, b: "x"} / [a, b]）解析成 JS 值。 */
function parseFlowValue(text) {
  const s = text.trim();
  if (!s) return '';

  if (s.startsWith('{') && s.endsWith('}')) {
    const out = {};
    for (const pair of splitTopLevel(s.slice(1, -1), ',')) {
      const colon = indexOfTopLevel(pair, ':');
      if (colon < 0) continue;
      const k = unquote(pair.slice(0, colon).trim());
      out[k] = parseFlowValue(pair.slice(colon + 1));
    }
    return out;
  }

  if (s.startsWith('[') && s.endsWith(']')) {
    return splitTopLevel(s.slice(1, -1), ',').map((x) => parseFlowValue(x));
  }

  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  return unquote(s);
}

/** 按分隔符切分，忽略引号与括号内的分隔符。 */
function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '' || out.length) out.push(cur);
  return out;
}

function indexOfTopLevel(text, ch) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{' || c === '[') depth += 1;
    if (c === '}' || c === ']') depth -= 1;
    if (c === ch && depth === 0) return i;
  }
  return -1;
}

/**
 * 从 Clash 订阅的 YAML 文本中提取 proxies 列表。
 * 只做「够用」的解析：支持 block 风格与 flow 风格，不支持锚点等高级特性。
 */
export function parseClashProxies(yamlText) {
  const text = String(yamlText || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  let start = -1;
  let indent = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:Proxy|proxies)\s*:\s*$/.exec(lines[i]);
    if (m) {
      start = i + 1;
      indent = m[1].length;
      break;
    }
  }
  if (start < 0) return [];

  // 收集属于该块的原始行
  const block = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) { block.push(line); continue; }
    const lead = line.length - line.trimStart().length;
    if (lead <= indent) break;
    block.push(line);
  }
  if (!block.length) return [];

  // 找到条目缩进
  let itemIndent = -1;
  for (const line of block) {
    const m = /^(\s*)-\s/.exec(line);
    if (m) { itemIndent = m[1].length; break; }
  }
  if (itemIndent < 0) return [];

  // 按条目切分
  const items = [];
  let current = null;
  for (const line of block) {
    if (!line.trim()) continue;
    const lead = line.length - line.trimStart().length;
    const m = /^(\s*)-\s*(.*)$/.exec(line);

    if (m && lead === itemIndent) {
      if (current) items.push(current);
      current = [m[2]];
      continue;
    }
    if (current) current.push(line.trim());
  }
  if (current) items.push(current);

  const nodes = [];
  for (const item of items) {
    if (!item.length) continue;

    // 整个条目是 flow 风格：- {name: x, type: ss, ...}
    const first = (item[0] || '').trim();
    if (first.startsWith('{')) {
      const obj = parseFlowValue(first);
      if (obj && typeof obj === 'object' && obj.name && obj.type && obj.server) nodes.push(obj);
      continue;
    }

    const obj = {};
    for (let i = 0; i < item.length; i += 1) {
      const line = item[i];
      if (!line) continue;

      const colon = indexOfTopLevel(line, ':');
      if (colon < 0) continue;

      const key = unquote(line.slice(0, colon).trim());
      const valueText = line.slice(colon + 1).trim();
      if (!key) continue;

      if (valueText) {
        obj[key] = parseFlowValue(valueText);
      } else {
        // 值是嵌套块：吃掉后续缩进更深的多行
        const nested = [];
        let j = i + 1;
        for (; j < item.length; j += 1) {
          if (!/^\s/.test(item[j]) && item[j].trim()) break;
          nested.push(item[j]);
        }
        obj[key] = parseNestedBlock(nested);
        i = j - 1;
      }
    }
    if (obj.name && obj.type && obj.server) nodes.push(obj);
  }

  return nodes;
}

/** 解析简单嵌套块（key: value 组成的 map）。 */
function parseNestedBlock(lines) {
  const out = {};
  for (const line of lines) {
    const colon = indexOfTopLevel(line, ':');
    if (colon < 0) continue;
    const k = unquote(line.slice(0, colon).trim());
    const v = line.slice(colon + 1).trim();
    if (!k) continue;
    out[k] = v ? parseFlowValue(v) : {};
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 订阅内容 → 节点列表                                                  */
/* ------------------------------------------------------------------ */

/**
 * 把订阅正文解析成节点列表。
 *
 * @param {string} content 订阅正文
 * @param {object} opts    { udp, tfo, scv }
 * @returns {{ nodes: object[], format: string }}
 */
export function parseSubscriptionContent(content, opts = {}) {
  const text = String(content || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return { nodes: [], format: 'empty' };

  // 1) Clash YAML
  if (/^\s*(Proxy|proxies)\s*:/m.test(text)) {
    const nodes = parseClashProxies(text);
    if (nodes.length) return { nodes, format: 'clash' };
  }

  // 2) SSD
  if (text.trim().startsWith('ssd://')) {
    const decoded = base64Decode(text.trim().slice(6));
    if (decoded) {
      try {
        const json = JSON.parse(decoded);
        const nodes = [];
        for (const s of json.servers || []) {
          const node = parseShareLink(
            `ss://${Buffer.from(`${s.encryption}:${s.password}`).toString('base64')}@${s.server}:${s.port}#${s.remarks || s.server}`,
            opts,
          );
          if (node) nodes.push(node);
        }
        return { nodes, format: 'ssd' };
      } catch {
        /* fallthrough */
      }
    }
  }

  // 3) 纯链接列表；先按原文解析
  const fromPlain = parseLinkList(text, opts);
  if (fromPlain.length) return { nodes: fromPlain, format: 'plain' };

  // 4) 整体是 base64 → 解码后再解析（机场最常见的格式）
  const stripped = text.replace(/\s+/g, '');
  if (looksLikeBase64(stripped)) {
    const decoded = base64Decode(stripped);
    if (decoded) {
      const nodes = parseLinkList(decoded.replace(/\r\n?/g, '\n'), opts);
      if (nodes.length) return { nodes, format: 'base64' };
    }
  }

  return { nodes: [], format: 'unknown' };
}

/**
 * 逐行解析链接。
 *
 * 先尝试把整行当成一条链接 —— 节点名里带空格很常见
 * （比如 "香港 IEPL 01"），一上来就按空格切会把它切坏。
 * 整行解析不了时，再退回去按空格拆，兼容「一行塞多个链接」的订阅。
 */
function parseLinkList(text, opts) {
  const nodes = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) continue;

    const whole = parseShareLink(line, opts);
    if (whole) {
      nodes.push(whole);
      continue;
    }

    for (const piece of line.split(/\s+/)) {
      if (!piece) continue;
      const node = parseShareLink(piece, opts);
      if (node) nodes.push(node);
    }
  }

  return nodes;
}
