// utils/classify.js —— 机型分类（与 Web 端 js/gev-class.js 同源，精简版）

// OpenSky 的 category 字段 → 机型类别
const CATEGORY_MAP = {
  2: 'light',       // < 15500 lbs
  3: 'airliner',    // Small
  4: 'airliner',    // Large
  5: 'airliner',    // High-vortex large (B757)
  6: 'widebody',    // Heavy
  7: 'fastjet',     // High performance
  8: 'helicopter',  // Rotorcraft
  9: 'glider',
};

const CLASS_CN = {
  light: '轻型机',
  glider: '滑翔机',
  turboprop: '涡桨',
  airliner: '窄体客机',
  widebody: '宽体客机',
  quadjet: '四发喷气',
  helicopter: '直升机',
  fastjet: '先进喷气',
  bizjet: '公务机',
  uav: '无人机',
};

/** 有 category 用 category，缺失时统一按窄体客机处理 */
function classify(cat) {
  const c = Number(cat);
  return CATEGORY_MAP[c] || 'airliner';
}

function planeIcon(cls) {
  const k = CLASS_CN[cls] ? cls : 'airliner';
  return `/images/plane-${k}.png`;
}

module.exports = { classify, CLASS_CN, planeIcon };
