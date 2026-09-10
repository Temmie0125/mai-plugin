/**
 * 今日舞萌（P3 实施文档 §5，D6 已拍板）
 *
 * 与源的差异（**唯一会改变用户可见文本的偏离**，文档 §13 R12 已登记）：
 * - 源的宜/忌是「扁平 13 项 + hash 位运算」，项数与内容都不固定（且 13 项里只有 11 项可能被用到）；
 *   本插件改为 good/bad/common 三分类 + 4 宜 4 忌抽取（照 phi-plugin 的 jrrp 形态）。
 * - 词库外置到 resources/info/fortune.json，可改数据而不动代码。
 *
 * 保留源的部分：qqhash 公式、rp = hash % 100、"同人同日同结果"的确定性（不引 Math.random、
 * 不引 redis）、推荐曲的 CPython MT19937 复刻（见 lib/mt19937.js）。
 */
import { qqhash } from './calc.js'
import { PyRandom } from './mt19937.js'
import fortuneJson from '../resources/info/fortune.json' with { type: 'json' }

const logger = global.logger || console

const WORD_KEYS = ['good', 'bad', 'common']
const DRAW_COUNT = 4

/**
 * 特例触发值（phi 用值域两端的 100 / 0）
 * 本插件沿用源的 `rp = hash % 100`，值域是 **0..99**，故上界取 99 而非 100 ——
 * phi 的 100 那一支在取模口径下永远不可达，「诸事皆宜」会永不出现。
 * 取 99 的语义是「本插件值域的上界」，正对应 phi 的 100；代价仅是 rp=99 时
 * 宜忌显示为「诸事皆宜」而源显示常规宜忌，**人品值数字本身与源完全一致**。
 * （曾评估把取模改 101 让 100 可达，实测那会让人品值在 99.1% 的情况下与源不同，见 §5.3 实施订正 2。）
 */
const RP_BEST = 99
const RP_WORST = 0

/** 词库缺失/为空时的内置兜底：保证命令永远可用，而不是被一个手改坏的 JSON 打成异常 */
const FALLBACK_WORDS = {
  good: ['上分', '收歌', '推AP', '抓绝赞'],
  bad: ['越级', '熬夜', '跳脸', '炸鱼'],
  common: ['拼机', '推分', '练底力', '练手法', '打旧框', '干饭', '打大歌', '下埋', '夜勤'],
}

/**
 * 词库校验与回退（三类任一缺失或为空即回退该项，并记一条明确告警）
 * @param {any} [raw] 注入用（默认取 resources/info/fortune.json）
 * @returns {{good: string[], bad: string[], common: string[]}}
 */
export function resolveWords(raw = fortuneJson) {
  const out = {}
  const missing = []
  for (const key of WORD_KEYS) {
    const list = Array.isArray(raw?.[key])
      ? raw[key].filter(x => typeof x === 'string' && x.trim())
      : []
    if (list.length) out[key] = [...list]
    else {
      out[key] = [...FALLBACK_WORDS[key]]
      missing.push(key)
    }
  }
  if (missing.length) {
    logger.error(
      `[mai-plugin] resources/info/fortune.json 的 ${missing.join(' / ')} 缺失或为空，` +
        '已回退内置兜底词库（不影响命令可用）'
    )
  }
  return out
}

/**
 * 确定性伪随机（与 tests/render-pages.mjs 同款 mulberry32）
 * 只用于抽宜/忌条目；rp 与推荐曲都不经过它——前者是 hash % 100，后者走 MT19937。
 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * phi 的抽取语义（apps/money.js:967-993 逐行对照）：在 `poolA.length + poolB.length`
 * 上取随机下标，落在 A 区就取 `poolA[idx]` 并 splice 移除，落在 B 区同理取 `poolB`。
 * 原地修改两个池 ⇒ n 个结果互不重复。
 */
function drawInto(out, rng, poolA, poolB, n) {
  for (let i = 0; i < n && poolA.length + poolB.length > 0; i++) {
    const idx = Math.floor(rng() * (poolA.length + poolB.length))
    out.push(idx < poolA.length ? poolA.splice(idx, 1)[0] : poolB.splice(idx - poolA.length, 1)[0])
  }
  return out
}

/** phi 的分档（0–5）：本批仅入参返回给将来的渲染页，文本形态不展示 */
export function luckRankOf(rp) {
  if (rp >= RP_BEST) return 5 // phi 是 `== 100 → 5`；此处跟随 RP_BEST 取上界，保持与特例一致
  if (rp >= 80) return 4
  if (rp >= 60) return 3
  if (rp >= 40) return 2
  if (rp >= 20) return 1
  return 0
}

/**
 * 今日舞萌数据（纯函数：不读全局、不发消息，呈现层在 apps/fun.js）
 * @param {number} qq 发起者的 qqid（源 `GetOrCreateSender` 语义：只认发起者，@ 他人无效）
 * @param {{date?: Date, list?: any[], words?: {good:string[],bad:string[],common:string[]}}} [opts]
 * @returns {{rp: number, luckRank: number, good: string[], bad: string[],
 *   song: any|null, special: boolean}}
 */
export function buildFortune(qq, { date = new Date(), list = [], words } = {}) {
  const hash = qqhash(qq, date)
  const rp = hash % 100
  const w = words ?? resolveWords()
  const rng = mulberry32(hash >>> 0) // 由 hash 播种 —— 同人同日必得同一结果

  let good
  let bad
  if (rp === RP_BEST) {
    // phi 的特例：宜与忌都填同一个词（apps/money.js:967-971）
    good = Array(DRAW_COUNT).fill('诸事皆宜')
    bad = Array(DRAW_COUNT).fill('诸事皆宜')
  } else if (rp === RP_WORST) {
    good = Array(DRAW_COUNT).fill('诸事不宜')
    bad = Array(DRAW_COUNT).fill('诸事不宜')
  } else {
    // ⚠️ 三个池各只拷贝一次，且**宜与忌共用同一份 common**——这是 phi 的实际行为
    // （一份 `let common = [...]` 被两个循环先后 splice），好处是同一条目不会
    // 既出现在宜里又出现在忌里（文档 §5.3 的「不重复抽取」）。
    // 务必先拷贝到变量再传：若写成 drawInto(..., [...w.common], ...) 两次，两轮就各拿一份副本，
    // 宜忌之间会重复——这正是本条注释要防的回归。
    const poolGood = [...w.good]
    const poolBad = [...w.bad]
    const poolCommon = [...w.common]
    good = drawInto([], rng, poolGood, poolCommon, DRAW_COUNT)
    bad = drawInto([], rng, poolBad, poolCommon, DRAW_COUNT)
  }

  // 推荐曲：源 `random.Random(fortune_hash).choice(mai.total_list.root)`，seed 是**完整 hash**
  // （不是 rp）——必须走 CPython MT19937 复刻才对得上源
  const song = list.length ? new PyRandom(hash).choice(list) : null

  return {
    rp,
    luckRank: luckRankOf(rp),
    good,
    bad,
    song,
    special: rp === RP_BEST || rp === RP_WORST,
  }
}
