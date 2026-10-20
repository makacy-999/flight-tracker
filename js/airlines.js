// 航司对照表：用于把用户输入映射为 OpenSky 的 callsign 前缀（ICAO 三字码）
// 每个条目：{ ic: ICAO代码, iata: IATA二字码, cn: 中文名, en: 英文名 }
const AIRLINES = [
  { ic: "CCA", iata: "CA",  cn: "中国国际航空", en: "Air China" },
  { ic: "CSN", iata: "CZ",  cn: "中国南方航空", en: "China Southern" },
  { ic: "CES", iata: "MU",  cn: "中国东方航空", en: "China Eastern" },
  { ic: "CHH", iata: "HU",  cn: "海南航空", en: "Hainan Airlines" },
  { ic: "CSC", iata: "3U",  cn: "四川航空", en: "Sichuan Airlines" },
  { ic: "CSZ", iata: "ZH",  cn: "深圳航空", en: "Shenzhen Airlines" },
  { ic: "CXA", iata: "MF",  cn: "厦门航空", en: "XiamenAir" },
  { ic: "CBJ", iata: "JD",  cn: "首都航空", en: "Beijing Capital Airlines" },
  { ic: "CDG", iata: "SC",  cn: "山东航空", en: "Shandong Airlines" },
  { ic: "DKH", iata: "HO",  cn: "吉祥航空", en: "Juneyao Air" },
  { ic: "CES", iata: "FM",  cn: "上海航空", en: "Shanghai Airlines" },
  { ic: "CPA", iata: "CX",  cn: "国泰航空", en: "Cathay Pacific" },
  { ic: "HDA", iata: "KA",  cn: "香港航空", en: "Hong Kong Airlines" },
  { ic: "CRK", iata: "HX",  cn: "香港航空", en: "Hong Kong Airlines" },
  { ic: "AMU", iata: "NX",  cn: "澳门航空", en: "Air Macau" },
  { ic: "CAL", iata: "CI",  cn: "中华航空", en: "China Airlines" },
  { ic: "EVA", iata: "BR",  cn: "长荣航空", en: "EVA Air" },
  { ic: "UAL", iata: "UA",  cn: "美国联合航空", en: "United Airlines" },
  { ic: "AAL", iata: "AA",  cn: "美国航空", en: "American Airlines" },
  { ic: "DAL", iata: "DL",  cn: "达美航空", en: "Delta Air Lines" },
  { ic: "BAW", iata: "BA",  cn: "英国航空", en: "British Airways" },
  { ic: "DLH", iata: "LH",  cn: "汉莎航空", en: "Lufthansa" },
  { ic: "AFR", iata: "AF",  cn: "法国航空", en: "Air France" },
  { ic: "KLM", iata: "KL",  cn: "荷兰皇家航空", en: "KLM" },
  { ic: "QFA", iata: "QF",  cn: "澳洲航空", en: "Qantas" },
  { ic: "SIA", iata: "SQ",  cn: "新加坡航空", en: "Singapore Airlines" },
  { ic: "THA", iata: "TG",  cn: "泰国国际航空", en: "Thai Airways" },
  { ic: "AAR", iata: "OZ",  cn: "韩亚航空", en: "Asiana Airlines" },
  { ic: "KAL", iata: "KE",  cn: "大韩航空", en: "Korean Air" },
  { ic: "ANA", iata: "NH",  cn: "全日空", en: "ANA" },
  { ic: "JAL", iata: "JL",  cn: "日本航空", en: "Japan Airlines" },
];

// 常用简称别名（用户口语化输入）
const ALIASES = {
  "国航": "中国国际航空", "国际航空": "中国国际航空", "airchina": "中国国际航空",
  "南航": "中国南方航空", "南方航空": "中国南方航空",
  "东航": "中国东方航空", "东方航空": "中国东方航空",
  "海航": "海南航空", "海南航空": "海南航空",
  "川航": "四川航空", "四川航空": "四川航空",
  "深航": "深圳航空", "深圳航空": "深圳航空",
  "厦航": "厦门航空", "厦门航空": "厦门航空",
  "山航": "山东航空", "山东航空": "山东航空",
  "吉祥": "吉祥航空", "吉祥航空": "吉祥航空",
  "首都航空": "首都航空", "首航": "首都航空",
};

// 构建多键映射，便于用户用任意形式（ICAO/IATA/中文/英文/简称）匹配
const AIRLINE_KEYS = new Map();
for (const a of AIRLINES) {
  const keys = [a.ic, a.iata, a.cn, a.en, (a.cn || "").replace("航空", ""), (a.en || "").toLowerCase()];
  for (const k of keys) {
    if (k) AIRLINE_KEYS.set(k.trim(), a);
  }
}
// 简称别名并入
for (const [alias, full] of Object.entries(ALIASES)) {
  const a = AIRLINE_KEYS.get(full);
  if (a) AIRLINE_KEYS.set(alias, a);
}

// 根据用户输入，返回 ICAO 前缀；若输入本身就是航班号（前缀+数字），直接返回前缀
function resolveAirlinePrefix(rawInput) {
  const inp = (rawInput || "").trim();
  if (!inp) return null;
  const up = inp.toUpperCase();
  // 航班号形如 CCA1654 / CA1654：取字母前缀
  const m = up.match(/^([A-Z]{2,3})(\d{1,4})$/);
  if (m) {
    const letters = m[1];
    // ICAO 三字码直接命中
    if (letters.length === 3 && AIRLINE_KEYS.has(letters)) return letters;
    // IATA 二字码
    const byIata = AIRLINE_KEYS.get(letters);
    if (byIata && byIata.iata === letters) return byIata.ic;
    // 大写字母前缀兜底直接用
    return letters;
  }
  // 纯字母：可能是 ICAO 或 IATA 或 中文/英文名称
  if (/^[A-Za-z]{2,8}$/.test(up)) {
    if (AIRLINE_KEYS.has(up)) return AIRLINE_KEYS.get(up).ic;
    return up; // 兜底：当作 ICAO 前缀
  }
  // 中文/英文名称
  const byName = AIRLINE_KEYS.get(inp) || AIRLINE_KEYS.get(inp.toLowerCase());
  if (byName) return byName.ic;
  return null;
}

// 根据 ICAO 前缀找航司可读名称
function airlineName(ic) {
  const a = AIRLINE_KEYS.get(ic);
  if (a) return `${a.cn}（${a.iata}/${a.ic}）`;
  return ic;
}