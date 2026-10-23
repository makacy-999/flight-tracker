// utils/airline.js —— 航司代码映射（与 Web 端 js/airlines.js 同源逻辑）

const AIRLINES = [
  { ic: 'CCA', iata: 'CA', cn: '中国国际航空', en: 'Air China' },
  { ic: 'CSN', iata: 'CZ', cn: '中国南方航空', en: 'China Southern' },
  { ic: 'CES', iata: 'MU', cn: '中国东方航空', en: 'China Eastern' },
  { ic: 'CHH', iata: 'HU', cn: '海南航空', en: 'Hainan Airlines' },
  { ic: 'CSC', iata: '3U', cn: '四川航空', en: 'Sichuan Airlines' },
  { ic: 'CSZ', iata: 'ZH', cn: '深圳航空', en: 'Shenzhen Airlines' },
  { ic: 'CXA', iata: 'MF', cn: '厦门航空', en: 'XiamenAir' },
  { ic: 'CBJ', iata: 'JD', cn: '首都航空', en: 'Beijing Capital Airlines' },
  { ic: 'CDG', iata: 'SC', cn: '山东航空', en: 'Shandong Airlines' },
  { ic: 'DKH', iata: 'HO', cn: '吉祥航空', en: 'Juneyao Air' },
  { ic: 'CPA', iata: 'CX', cn: '国泰航空', en: 'Cathay Pacific' },
  { ic: 'HDA', iata: 'KA', cn: '香港航空', en: 'Hong Kong Airlines' },
  { ic: 'AMU', iata: 'NX', cn: '澳门航空', en: 'Air Macau' },
  { ic: 'CAL', iata: 'CI', cn: '中华航空', en: 'China Airlines' },
  { ic: 'EVA', iata: 'BR', cn: '长荣航空', en: 'EVA Air' },
  { ic: 'UAL', iata: 'UA', cn: '美国联合航空', en: 'United Airlines' },
  { ic: 'AAL', iata: 'AA', cn: '美国航空', en: 'American Airlines' },
  { ic: 'DAL', iata: 'DL', cn: '达美航空', en: 'Delta Air Lines' },
  { ic: 'BAW', iata: 'BA', cn: '英国航空', en: 'British Airways' },
  { ic: 'DLH', iata: 'LH', cn: '汉莎航空', en: 'Lufthansa' },
  { ic: 'AFR', iata: 'AF', cn: '法国航空', en: 'Air France' },
  { ic: 'KLM', iata: 'KL', cn: '荷兰皇家航空', en: 'KLM' },
  { ic: 'QFA', iata: 'QF', cn: '澳洲航空', en: 'Qantas' },
  { ic: 'SIA', iata: 'SQ', cn: '新加坡航空', en: 'Singapore Airlines' },
  { ic: 'THA', iata: 'TG', cn: '泰国国际航空', en: 'Thai Airways' },
  { ic: 'AAR', iata: 'OZ', cn: '韩亚航空', en: 'Asiana Airlines' },
  { ic: 'KAL', iata: 'KE', cn: '大韩航空', en: 'Korean Air' },
  { ic: 'ANA', iata: 'NH', cn: '全日空', en: 'ANA' },
  { ic: 'JAL', iata: 'JL', cn: '日本航空', en: 'Japan Airlines' },
  { ic: 'FDX', iata: 'FX', cn: '联邦快递', en: 'FedEx' },
  { ic: 'UPS', iata: '5X', cn: '联合包裹', en: 'UPS' },
  { ic: 'GTI', iata: '5Y', cn: '亚特拉斯航空', en: 'Atlas Air' },
  { ic: 'CLX', iata: 'CV', cn: '卢森堡货航', en: 'Cargolux' },
  { ic: 'BOX', iata: '3S', cn: '空桥货运', en: 'AeroLogic' },
  { ic: 'SQC', iata: 'SQ', cn: '新航货运', en: 'Singapore Airlines Cargo' },
];

const ALIASES = {
  国航: '中国国际航空', 国际航空: '中国国际航空', airchina: '中国国际航空',
  南航: '中国南方航空', 南方航空: '中国南方航空',
  东航: '中国东方航空', 东方航空: '中国东方航空',
  海航: '海南航空', 海南航空: '海南航空',
  川航: '四川航空', 四川航空: '四川航空',
  深航: '深圳航空', 深圳航空: '深圳航空',
  厦航: '厦门航空', 厦门航空: '厦门航空',
  山航: '山东航空', 山东航空: '山东航空',
  吉祥: '吉祥航空', 吉祥航空: '吉祥航空',
  首都航空: '首都航空', 首航: '首都航空',
  顺丰: '顺丰航空',
};

const KEYS = new Map();
AIRLINES.forEach((a) => {
  const keys = [a.ic, a.iata, a.cn, a.en, (a.cn || '').replace('航空', ''), (a.en || '').toLowerCase()];
  keys.forEach((k) => {
    if (k) KEYS.set(String(k).trim(), a);
  });
});
Object.entries(ALIASES).forEach(([alias, full]) => {
  const a = KEYS.get(full);
  if (a) KEYS.set(alias, a);
});

/** 用户输入 → ICAO 前缀（CCA / CSN …） */
function resolveAirlinePrefix(raw) {
  const inp = (raw || '').trim();
  if (!inp) return null;
  const up = inp.toUpperCase();

  // 航班号 CCA1654 / CA1654
  const m = up.match(/^([A-Z]{2,3})(\d{1,4})$/);
  if (m) {
    const letters = m[1];
    if (letters.length === 3 && KEYS.has(letters)) return letters;
    const byIata = KEYS.get(letters);
    if (byIata && byIata.iata === letters) return byIata.ic;
    return letters;
  }
  if (/^[A-Z]{2,8}$/.test(up)) {
    if (KEYS.has(up)) return KEYS.get(up).ic;
    return up;
  }
  const byName = KEYS.get(inp) || KEYS.get(inp.toLowerCase());
  return byName ? byName.ic : null;
}

/** ICAO 前缀 → 中文航司名 */
function airlineCn(callsign) {
  if (!callsign) return '';
  const cs = String(callsign).toUpperCase();
  const a = KEYS.get(cs.slice(0, 3)) || KEYS.get(cs.slice(0, 2));
  return (a && a.cn) || '';
}

module.exports = { AIRLINES, resolveAirlinePrefix, airlineCn };
