/**
 * 节点名美化与过滤。
 *
 * 机场给的节点名五花八门（"香港01" / "HK-01" / "🇭🇰香港 IEPL"），
 * 这里统一补上国旗 emoji，让 ZJU.ini 里那些按地区分组的正则在界面上
 * 看起来更直观，也方便同学手动挑节点。
 */

/** 地区关键词 → 国旗 emoji。顺序有意义：先匹配的先命中。 */
const REGION_MAP = [
  [['香港', 'hongkong', 'hong kong', 'hk', 'hkg', '港'], '🇭🇰'],
  [['台湾', 'taiwan', 'tw', 'twn', '新北', '彰化', '台'], '🇨🇳'],
  [['日本', 'japan', 'jp', 'jpn', '东京', '大阪', '埼玉'], '🇯🇵'],
  [['韩国', 'korea', 'kr', 'kor', '首尔', '韩'], '🇰🇷'],
  [['新加坡', 'singapore', 'sg', 'sgp', '狮城', '坡'], '🇸🇬'],
  [['美国', 'united states', 'usa', 'us', '洛杉矶', '圣何塞', '西雅图', '芝加哥', '硅谷'], '🇺🇸'],
  [['英国', 'united kingdom', 'uk', 'gb', '伦敦'], '🇬🇧'],
  [['德国', 'germany', 'de', '法兰克福'], '🇩🇪'],
  [['法国', 'france', 'fr', '巴黎'], '🇫🇷'],
  [['荷兰', 'netherlands', 'nl', '阿姆斯特丹'], '🇳🇱'],
  [['俄罗斯', 'russia', 'ru', '莫斯科'], '🇷🇺'],
  [['加拿大', 'canada', 'ca', '多伦多'], '🇨🇦'],
  [['澳大利亚', 'australia', 'au', '悉尼'], '🇦🇺'],
  [['印度', 'india', 'in', '孟买'], '🇮🇳'],
  [['土耳其', 'turkey', 'tr', '伊斯坦布尔'], '🇹🇷'],
  [['阿根廷', 'argentina', 'ar'], '🇦🇷'],
  [['巴西', 'brazil', 'br'], '🇧🇷'],
  [['马来西亚', 'malaysia', 'my', '吉隆坡'], '🇲🇾'],
  [['泰国', 'thailand', 'th', '曼谷'], '🇹🇭'],
  [['越南', 'vietnam', 'vn'], '🇻🇳'],
  [['菲律宾', 'philippines', 'ph'], '🇵🇭'],
  [['印尼', 'indonesia', 'id', '雅加达'], '🇮🇩'],
  [['中国', 'china', 'cn', '回国', '上海', '北京', '广州', '深圳'], '🇨🇳'],
];

/** 名字里已经带国旗的话就不再重复加。 */
const HAS_FLAG = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

/**
 * 给节点名补国旗 emoji。
 * 已经带国旗的、或者匹配不到地区的，原样返回。
 */
export function decorateName(name) {
  const raw = String(name || '').trim();
  if (!raw) return raw;
  if (HAS_FLAG.test(raw)) return raw;

  const lower = raw.toLowerCase();
  for (const [keywords, flag] of REGION_MAP) {
    for (const kw of keywords) {
      // 纯 ASCII 关键词要求按「词」匹配，避免 us 命中 "russia"
      if (/^[a-z ]+$/.test(kw)) {
        const re = new RegExp(`(^|[^a-z])${kw.replace(/ /g, '\\s*')}([^a-z]|$)`, 'i');
        if (re.test(lower)) return `${flag} ${raw}`;
      } else if (lower.includes(kw)) {
        return `${flag} ${raw}`;
      }
    }
  }

  return raw;
}

/** 协议名 → 节点名后缀。 */
const TYPE_LABEL = {
  ss: 'SS',
  ssr: 'SSR',
  vmess: 'VMess',
  vless: 'VLESS',
  trojan: 'Trojan',
  hysteria: 'Hysteria',
  hysteria2: 'Hysteria2',
  tuic: 'TUIC',
  socks5: 'SOCKS5',
  http: 'HTTP',
};

/**
 * 对节点列表做过滤 + 重命名。
 *
 * @param {object[]} nodes
 * @param {object}   opts
 * @param {string}   [opts.exclude]     排除节点名的正则
 * @param {string}   [opts.include]     仅保留节点名的正则
 * @param {boolean}  [opts.emoji]       是否补国旗
 * @param {boolean}  [opts.appendType]  是否在名字后追加 [SS] 之类
 * @param {boolean}  [opts.sort]        是否按名字排序
 * @returns {object[]}
 */
export function processNodes(nodes, opts = {}) {
  let list = [...nodes];

  const exclude = compile(opts.exclude);
  const include = compile(opts.include);

  if (exclude) list = list.filter((n) => !exclude.test(n.name));
  if (include) list = list.filter((n) => include.test(n.name));

  // 名字去重：重复的名字会让 Clash 直接报错
  const seen = new Map();
  for (const node of list) {
    let name = String(node.name || '').trim() || `${node.server}:${node.port}`;

    if (opts.emoji) name = decorateName(name);
    if (opts.appendType) {
      const label = TYPE_LABEL[node.type];
      if (label && !name.includes(`[${label}]`)) name = `${name} [${label}]`;
    }

    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    node.name = count === 0 ? name : `${name} ${count + 1}`;
  }

  if (opts.sort) {
    list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
  }

  return list;
}

function compile(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

export { TYPE_LABEL };
