/**
 * 内部小工具：base64、URL、字符串处理。
 * 不依赖任何第三方库，方便直接在 Vercel Serverless 里跑。
 */

/** 把标准 base64 转成 URL-safe 形式，并去掉 padding。 */
export function toUrlSafe(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 宽松的 base64 解码：
 *   - 自动处理 URL-safe 字符（- _）
 *   - 自动补齐 padding
 *   - 自动忽略换行与空白
 * 解码失败返回 null。
 */
export function base64Decode(input) {
  if (input == null) return null;

  let s = String(input).replace(/\s+/g, '');
  if (!s) return null;

  s = s.replace(/-/g, '+').replace(/_/g, '/');

  const pad = s.length % 4;
  if (pad === 1) return null; // 长度非法
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';

  // 只保留合法字符，避免 Buffer 静默产出垃圾
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;

  try {
    const buf = Buffer.from(s, 'base64');
    if (!buf.length) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** base64 编码（URL-safe 可选）。 */
export function base64Encode(text, urlSafe = false) {
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  return urlSafe ? toUrlSafe(b64) : b64;
}

/**
 * 判断一段文本是否「看起来像」base64 编码的内容。
 * 用于区分机场的 base64 订阅与明文节点列表。
 */
export function looksLikeBase64(text) {
  const s = String(text).replace(/\s+/g, '');
  if (s.length < 8) return false;
  if (!/^[A-Za-z0-9+/\-_]+={0,2}$/.test(s)) return false;
  const decoded = base64Decode(s);
  if (!decoded) return false;
  // 解出来的东西应该基本是可打印文本
  const printable = decoded.replace(/[^\x20-\x7E\u4e00-\u9fa5\s]/g, '');
  return printable.length / decoded.length > 0.85;
}

/** 安全地 decodeURIComponent。 */
export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 把 #后面的 remark 解码出来。 */
export function parseRemark(link) {
  const hash = link.indexOf('#');
  if (hash < 0) return '';
  return safeDecode(link.slice(hash + 1)).trim();
}

/** 拆掉链接里的 #remark 部分。 */
export function stripRemark(link) {
  const hash = link.indexOf('#');
  return hash < 0 ? link : link.slice(0, hash);
}

/** 解析查询串为普通对象。 */
export function parseQuery(str) {
  const out = {};
  if (!str) return out;
  const q = str.startsWith('?') ? str.slice(1) : str;
  for (const pair of q.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    out[safeDecode(k)] = safeDecode(v);
  }
  return out;
}

/** 端口字符串 → 数字，非法返回 0。 */
export function toPort(v) {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
}

/** 去掉首尾引号。 */
export function unquote(s) {
  if (typeof s !== 'string') return s;
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** 转成 YAML 双引号标量，保证任何字符都能安全输出。 */
export function yamlString(value) {
  const s = String(value ?? '');
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}"`;
}
