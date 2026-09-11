/**
 * 把节点对象重新序列化成分享链接。
 *
 * 用途：给那些不吃 Clash 配置的客户端（Shadowrocket、v2rayN 等）
 * 生成 base64 节点列表订阅。
 */

import { base64Encode, toUrlSafe } from './util.mjs';

/** 节点名放进 URL fragment 前要做编码。 */
function frag(name) {
  return encodeURIComponent(String(name || ''));
}

function query(params) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function serializeShadowsocks(n) {
  const userInfo = toUrlSafe(base64Encode(`${n.cipher}:${n.password}`));
  const params = {};
  if (n.plugin === 'obfs') {
    params.plugin = `obfs-local;obfs=${n['plugin-opts']?.mode || 'http'};obfs-host=${n['plugin-opts']?.host || ''}`;
  }
  return `ss://${userInfo}@${n.server}:${n.port}${query(params)}#${frag(n.name)}`;
}

function serializeVmess(n) {
  const json = {
    v: '2',
    ps: n.name,
    add: n.server,
    port: String(n.port),
    id: n.uuid,
    aid: String(n.alterId ?? 0),
    scy: n.cipher && n.cipher !== 'auto' ? n.cipher : 'auto',
    net: n.network || 'tcp',
    type: 'none',
    host: n['ws-opts']?.headers?.Host || (n['h2-opts']?.host || []).join(',') || '',
    path: n['ws-opts']?.path || n['h2-opts']?.path || n['grpc-opts']?.['grpc-service-name'] || '',
    tls: n.tls ? 'tls' : '',
    sni: n.servername || '',
  };
  return `vmess://${base64Encode(JSON.stringify(json))}`;
}

function serializeVless(n) {
  const params = {
    encryption: 'none',
    type: n.network || 'tcp',
    security: n['reality-opts'] ? 'reality' : n.tls ? 'tls' : '',
    sni: n.servername || '',
    flow: n.flow,
    path: n['ws-opts']?.path || n['grpc-opts']?.['grpc-service-name'],
    host: n['ws-opts']?.headers?.Host,
    fp: n['client-fingerprint'],
    pbk: n['reality-opts']?.['public-key'],
    sid: n['reality-opts']?.['short-id'],
  };
  return `vless://${n.uuid}@${n.server}:${n.port}${query(params)}#${frag(n.name)}`;
}

function serializeTrojan(n) {
  const params = {
    sni: n.sni || n.servername,
    type: n.network && n.network !== 'tcp' ? n.network : '',
    path: n['ws-opts']?.path,
    host: n['ws-opts']?.headers?.Host,
    allowInsecure: n['skip-cert-verify'] ? '1' : '',
  };
  return `trojan://${encodeURIComponent(n.password)}@${n.server}:${n.port}${query(params)}#${frag(n.name)}`;
}

function serializeHysteria2(n) {
  const params = {
    sni: n.sni,
    insecure: n['skip-cert-verify'] ? '1' : '',
    obfs: n.obfs,
    'obfs-password': n['obfs-password'],
  };
  return `hysteria2://${encodeURIComponent(n.password || '')}@${n.server}:${n.port}${query(params)}#${frag(n.name)}`;
}

function serializeSocksHttp(n) {
  const scheme = n.tls ? 'https' : n.type;
  const auth = n.username ? `${encodeURIComponent(n.username)}:${encodeURIComponent(n.password || '')}@` : '';
  return `${scheme}://${auth}${n.server}:${n.port}#${frag(n.name)}`;
}

const SERIALIZERS = {
  ss: serializeShadowsocks,
  vmess: serializeVmess,
  vless: serializeVless,
  trojan: serializeTrojan,
  hysteria2: serializeHysteria2,
  socks5: serializeSocksHttp,
  http: serializeSocksHttp,
};

/**
 * 节点数组 → base64 编码的分享链接列表。
 *
 * @param {object[]} nodes
 * @returns {{ text: string, encoded: string, skipped: string[] }}
 */
export function nodesToLinks(nodes) {
  const lines = [];
  const skipped = [];

  for (const node of nodes) {
    const fn = SERIALIZERS[node.type];
    if (!fn) {
      skipped.push(node.type);
      continue;
    }
    try {
      lines.push(fn(node));
    } catch {
      skipped.push(node.type);
    }
  }

  const text = lines.join('\n');
  return { text, encoded: base64Encode(text), skipped: [...new Set(skipped)] };
}
