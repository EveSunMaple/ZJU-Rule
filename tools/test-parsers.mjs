/**
 * 内置转换引擎的解析器测试。
 *   node tools/test-parsers.mjs
 * 纯离线，不需要联网，也不需要 subconverter。
 */

import assert from 'node:assert/strict';

import { parseShareLink, parseSubscriptionContent, parseClashProxies } from '../lib/engine/nodes.mjs';
import { base64Encode } from '../lib/engine/util.mjs';

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label}\n      ${err.message}`);
  }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

console.log('\n解析分享链接');

check('ss (SIP002)', () => {
  const n = parseShareLink(`ss://${b64('aes-256-gcm:pass123')}@1.2.3.4:8388#HK-01`);
  assert.equal(n.type, 'ss');
  assert.equal(n.cipher, 'aes-256-gcm');
  assert.equal(n.password, 'pass123');
  assert.equal(n.server, '1.2.3.4');
  assert.equal(n.port, 8388);
  assert.equal(n.name, 'HK-01');
  assert.equal(n.udp, true);
});

check('ss (传统整体 base64)', () => {
  const n = parseShareLink(`ss://${b64('aes-128-gcm:pw@5.6.7.8:443')}#JP-02`);
  assert.equal(n.server, '5.6.7.8');
  assert.equal(n.port, 443);
  assert.equal(n.cipher, 'aes-128-gcm');
  assert.equal(n.name, 'JP-02');
});

check('ss + obfs 插件', () => {
  const n = parseShareLink(
    `ss://${b64('aes-256-gcm:pw')}@1.1.1.1:443?plugin=obfs-local%3Bobfs%3Dtls%3Bobfs-host%3Dbing.com#OBFS`,
  );
  assert.equal(n.plugin, 'obfs');
  assert.equal(n['plugin-opts'].mode, 'tls');
  assert.equal(n['plugin-opts'].host, 'bing.com');
});

check('ssr', () => {
  const inner = `1.2.3.4:8388:auth_aes128_md5:aes-256-cfb:tls1.2_ticket_auth:${Buffer.from('ssrpass').toString('base64url')}/?remarks=${Buffer.from('SSR 节点').toString('base64url')}&obfsparam=`;
  const n = parseShareLink(`ssr://${Buffer.from(inner).toString('base64url')}`);
  assert.equal(n.type, 'ssr');
  assert.equal(n.server, '1.2.3.4');
  assert.equal(n.protocol, 'auth_aes128_md5');
  assert.equal(n.obfs, 'tls1.2_ticket_auth');
  assert.equal(n.password, 'ssrpass');
  assert.equal(n.name, 'SSR 节点');
});

check('vmess (ws + tls)', () => {
  const json = {
    v: '2', ps: 'VM-WS', add: 'hk.example.com', port: '443',
    id: 'b8315e1b-1a2b-4321-8b1a-2c3d4e5f6a7b', aid: '0', scy: 'auto',
    net: 'ws', type: 'none', host: 'hk.example.com', path: '/ws', tls: 'tls', sni: 'hk.example.com',
  };
  const n = parseShareLink(`vmess://${b64(JSON.stringify(json))}`);
  assert.equal(n.type, 'vmess');
  assert.equal(n.uuid, json.id);
  assert.equal(n.network, 'ws');
  assert.equal(n.tls, true);
  assert.equal(n['ws-opts'].path, '/ws');
  assert.equal(n['ws-opts'].headers.Host, 'hk.example.com');
  assert.equal(n.servername, 'hk.example.com');
});

check('vless (reality + grpc)', () => {
  const n = parseShareLink(
    'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443' +
      '?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome' +
      '&pbk=abcdefg&sid=1234&type=grpc&serviceName=grpcsvc#VLESS-REALITY',
  );
  assert.equal(n.type, 'vless');
  assert.equal(n.uuid, '11111111-2222-3333-4444-555555555555');
  assert.equal(n.tls, true);
  assert.equal(n.servername, 'www.microsoft.com');
  assert.equal(n['client-fingerprint'], 'chrome');
  assert.equal(n['reality-opts']['public-key'], 'abcdefg');
  assert.equal(n['reality-opts']['short-id'], '1234');
  assert.equal(n['grpc-opts']['grpc-service-name'], 'grpcsvc');
});

check('trojan', () => {
  const n = parseShareLink('trojan://pass123@jp.example.com:443?sni=jp.example.com&allowInsecure=1#JP-TR');
  assert.equal(n.type, 'trojan');
  assert.equal(n.password, 'pass123');
  assert.equal(n.sni, 'jp.example.com');
  assert.equal(n['skip-cert-verify'], true);
  assert.equal(n.tls, true);
});

check('hysteria2', () => {
  const n = parseShareLink('hysteria2://pw@1.2.3.4:8443?sni=x.com&insecure=1&obfs=salamander&obfs-password=abc#HY2');
  assert.equal(n.type, 'hysteria2');
  assert.equal(n.password, 'pw');
  assert.equal(n.port, 8443);
  assert.equal(n.obfs, 'salamander');
  assert.equal(n['obfs-password'], 'abc');
  assert.equal(n['skip-cert-verify'], true);
});

check('hysteria (v1)', () => {
  const n = parseShareLink('hysteria://1.2.3.4:443?protocol=udp&auth=tok&peer=sni.com&upmbps=50&downmbps=100#HY1');
  assert.equal(n.type, 'hysteria');
  assert.equal(n['auth-str'], 'tok');
  assert.equal(n.sni, 'sni.com');
  assert.equal(n.up, '50');
});

check('tuic', () => {
  const n = parseShareLink('tuic://uuid-1:pw@1.2.3.4:443?sni=x.com&congestion_control=bbr&alpn=h3#TUIC');
  assert.equal(n.type, 'tuic');
  assert.equal(n.uuid, 'uuid-1');
  assert.equal(n.password, 'pw');
  assert.equal(n['congestion-controller'], 'bbr');
  assert.deepEqual(n.alpn, ['h3']);
});

check('socks5 / http', () => {
  const s = parseShareLink('socks5://user:pass@1.2.3.4:1080#S5');
  assert.equal(s.type, 'socks5');
  assert.equal(s.username, 'user');
  assert.equal(s.password, 'pass');

  const h = parseShareLink('http://1.2.3.4:8080#HTTP');
  assert.equal(h.type, 'http');
  assert.equal(h.port, 8080);
});

check('IPv6 地址', () => {
  const n = parseShareLink(`ss://${b64('aes-256-gcm:pw')}@[2001:db8::1]:8388#V6`);
  assert.equal(n.server, '2001:db8::1');
  assert.equal(n.port, 8388);
});

check('非法链接返回 null 而不抛异常', () => {
  assert.equal(parseShareLink('这不是链接'), null);
  assert.equal(parseShareLink('ss://'), null);
  assert.equal(parseShareLink('vmess://bm90LWpzb24='), null);
  assert.equal(parseShareLink('unknown://a@b:1'), null);
});

console.log('\n解析订阅正文');

check('base64 订阅（机场标准格式）', () => {
  const links = [
    `ss://${b64('aes-256-gcm:pw')}@1.2.3.4:8388#HK-01`,
    `trojan://pw@jp.example.com:443#JP-02`,
  ].join('\n');
  const { nodes, format } = parseSubscriptionContent(base64Encode(links));
  assert.equal(format, 'base64');
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].name, 'HK-01');
  assert.equal(nodes[1].name, 'JP-02');
});

check('明文链接列表也能解析（比 subconverter 更强）', () => {
  const links = [
    `ss://${b64('aes-256-gcm:pw')}@1.2.3.4:8388#HK-01`,
    'trojan://pw@jp.example.com:443#JP-02',
  ].join('\n');
  const { nodes, format } = parseSubscriptionContent(links);
  assert.equal(format, 'plain');
  assert.equal(nodes.length, 2);
});

check('带注释和空行的列表', () => {
  const { nodes } = parseSubscriptionContent(
    `# 这是注释\n\nss://${b64('aes-256-gcm:pw')}@1.2.3.4:8388#HK-01\n`,
  );
  assert.equal(nodes.length, 1);
});

check('Clash YAML 订阅（flow 风格）', () => {
  const yaml = [
    'proxies:',
    '  - {name: HK-01, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-256-gcm, password: pw}',
    '  - {name: JP-02, type: trojan, server: jp.example.com, port: 443, password: pw}',
    '',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '',
  ].join('\n');
  const { nodes, format } = parseSubscriptionContent(yaml);
  assert.equal(format, 'clash');
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].name, 'HK-01');
  assert.equal(nodes[1].type, 'trojan');
});

check('Clash YAML 订阅（block 风格）', () => {
  const yaml = [
    'proxies:',
    '  - name: HK-Block',
    '    type: vmess',
    '    server: hk.example.com',
    '    port: 443',
    '    uuid: abc-123',
    '    alterId: 0',
    '    cipher: auto',
    '    udp: true',
    '    ws-opts:',
    '      path: /path',
    '    network: ws',
    '',
    'rules:',
    '  - MATCH,DIRECT',
    '',
  ].join('\n');
  const { nodes } = parseSubscriptionContent(yaml);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'HK-Block');
  assert.equal(nodes[0].server, 'hk.example.com');
  assert.equal(nodes[0].uuid, 'abc-123');
  assert.equal(nodes[0].network, 'ws');
});

check('parseClashProxies 不会被后面的顶层键吞掉', () => {
  const nodes = parseClashProxies('proxies:\n  - {name: A, type: ss, server: 1.1.1.1, port: 80, cipher: aes-128-gcm, password: x}\nrules:\n  - MATCH,DIRECT\n');
  assert.equal(nodes.length, 1);
});

check('空订阅 / 无效内容', () => {
  assert.equal(parseSubscriptionContent('').nodes.length, 0);
  assert.equal(parseSubscriptionContent('hello world').nodes.length, 0);
  assert.equal(parseSubscriptionContent('{"foo":1}').nodes.length, 0);
});

check('udp / scv 开关可关闭', () => {
  const n = parseShareLink(`ss://${b64('aes-256-gcm:pw')}@1.2.3.4:8388#X`, { udp: false, scv: false });
  assert.equal(n.udp, undefined);
  assert.equal(n['skip-cert-verify'], undefined);
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
