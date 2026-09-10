import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildFortune, resolveWords, luckRankOf } from '../lib/fortune.js'
import { qqhash } from '../lib/calc.js'
import { PyRandom } from '../lib/mt19937.js'
import { MaiFortune, MaiFortuneSay, fortuneSeed, fortuneText } from '../apps/fun.js'

// 宿主全局 logger 打桩（fortune 模块顶层捕获 global.logger）
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

const DATE = new Date(2026, 8, 10)
const LIST = Array.from({ length: 100 }, (_, i) => ({ song_id: 1000 + i }))
/** 桩词库：好/坏/通用各自可辨，便于断言"取到的是哪一类" */
const WORDS = {
  good: ['G1', 'G2', 'G3', 'G4', 'G5'],
  bad: ['B1', 'B2', 'B3', 'B4', 'B5'],
  common: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
}
const build = (qq, words = WORDS) => buildFortune(qq, { date: DATE, list: LIST, words })

/** 扫出 rp 恰为 target 的 qq（rp = qqhash % 100，扫描比构造反解更直观） */
function findQqWithRp(target, limit = 200000) {
  for (let qq = 1; qq <= limit; qq++) if (qqhash(qq, DATE) % 100 === target) return qq
  return null
}

test('buildFortune：rp = qqhash % 100，且同人同日两次调用全等', () => {
  for (const qq of [1, 114514, 2793812633]) {
    const a = build(qq)
    const b = build(qq)
    assert.deepEqual(a, b, `qq=${qq} 应确定性（同人同日同结果）`)
    assert.equal(a.rp, qqhash(qq, DATE) % 100)
  }
})

test('buildFortune：日期参与 hash，换一天结果发生变化', () => {
  const a = buildFortune(114514, { date: new Date(2026, 8, 10), list: LIST, words: WORDS })
  const b = buildFortune(114514, { date: new Date(2026, 8, 11), list: LIST, words: WORDS })
  assert.notDeepEqual(
    { rp: a.rp, good: a.good, bad: a.bad, song: a.song },
    { rp: b.rp, good: b.good, bad: b.bad, song: b.song },
  )
})

test('buildFortune：非特例时宜忌各 4 项，且 8 项互不重复（宜忌共用同一份 common）', () => {
  let checked = 0
  for (let qq = 1; qq <= 500; qq++) {
    const r = build(qq)
    if (r.special) continue
    checked++
    assert.equal(r.good.length, 4, `qq=${qq} 宜应为 4 项`)
    assert.equal(r.bad.length, 4, `qq=${qq} 忌应为 4 项`)
    const all = [...r.good, ...r.bad]
    assert.equal(new Set(all).size, 8, `qq=${qq} 宜忌之间不得重复：${all.join(',')}`)
    for (const item of r.good) assert.ok(WORDS.good.includes(item) || WORDS.common.includes(item))
    for (const item of r.bad) assert.ok(WORDS.bad.includes(item) || WORDS.common.includes(item))
  }
  assert.ok(checked > 450, `非特例样本应足够多（实际 ${checked}）`)
})

test('buildFortune：rp 0 走「诸事不宜」特例，宜忌同词（phi 形态）', () => {
  const qq = findQqWithRp(0)
  assert.ok(qq, '应能扫出 rp=0 的 qq')
  const r = build(qq)
  assert.equal(r.rp, 0)
  assert.equal(r.special, true)
  assert.equal(r.luckRank, 0)
  assert.deepEqual(r.good, Array(4).fill('诸事不宜'))
  assert.deepEqual(r.bad, Array(4).fill('诸事不宜'))
})

test('buildFortune：rp 99 走「诸事皆宜」特例（上界触发，两个特例分支都可达）', () => {
  // 源/phi 的上界触发值是 100，但本插件沿源 `rp = hash % 100` 值域只有 0..99，
  // 100 永远不可达 ⇒ 取 99 作上界（语义：本插件值域的上界）。详见 lib/fortune.js 的 RP_BEST 注释。
  const qq = findQqWithRp(99)
  assert.ok(qq, '应能扫出 rp=99 的 qq')
  const r = build(qq)
  assert.equal(r.rp, 99)
  assert.equal(r.special, true)
  assert.equal(r.luckRank, 5, '上界特例应与 phi 的 100 同档')
  assert.deepEqual(r.good, Array(4).fill('诸事皆宜'))
  assert.deepEqual(r.bad, Array(4).fill('诸事皆宜'))
})

test('buildFortune：rp 恒在 0..99（沿用源口径，人品值数字与源插件一致）', () => {
  // 曾评估把取模改 101 让 100 可达——实测那会让人品值在 99.1% 的情况下与源插件不同，
  // 故保留 `% 100` 并改由上界 99 触发特例。这里钉住值域，防止后人再改回去。
  assert.equal(findQqWithRp(100, 20000), null, '按当前 rp 口径不应存在 rp=100')
  let best = 0
  for (let qq = 1; qq <= 3000; qq++) {
    const { rp } = build(qq)
    assert.ok(rp >= 0 && rp <= 99, `rp 越界：${rp}`)
    best = Math.max(best, rp)
  }
  assert.ok(best > 90, `样本应覆盖到高分区（实际最高 ${best}）`)
})

test('buildFortune：两个特例分支的出现率同量级（各约 1%）', () => {
  let best = 0
  let worst = 0
  const n = 5000
  for (let qq = 1; qq <= n; qq++) {
    const r = build(qq)
    if (r.rp === 99) best++
    if (r.rp === 0) worst++
  }
  assert.ok(best > 0, 'rp=99 必须可达')
  assert.ok(worst > 0, 'rp=0 必须可达')
  assert.ok(Math.abs(best - worst) < n * 0.01, `两侧应同量级（99→${best} 次，0→${worst} 次）`)
})

test('buildFortune：推荐曲的 MT19937 种子是**完整 hash** 而非 rp（源口径）', () => {
  // 必须挑 hash 明显大于 rp 的样本，否则「用 hash 还是用 rp 当种子」测不出来
  for (const qq of [999, 114514, 2793812633]) {
    const h = qqhash(qq, DATE)
    assert.ok(h > 100, `样本 hash 应大于 rp 量级（qq=${qq} h=${h}）`)
    assert.equal(build(qq).song, new PyRandom(h).choice(LIST), `qq=${qq} 种子口径不符`)
  }
})

test('buildFortune：曲库为空时 song 为 null 而不抛错', () => {
  const r = buildFortune(114514, { date: DATE, list: [], words: WORDS })
  assert.equal(r.song, null)
  assert.equal(r.good.length, 4, '无曲库也应给出宜忌')
})

test('buildFortune：不修改传入的词库（内部先拷贝）', () => {
  const src = { good: [...WORDS.good], bad: [...WORDS.bad], common: [...WORDS.common] }
  const snapshot = JSON.stringify(src)
  for (let qq = 1; qq <= 50; qq++) build(qq, src)
  assert.equal(JSON.stringify(src), snapshot, '抽签不得污染调用方的词库数组')
})

test('resolveWords：缺失/为空/脏值一律回退兜底，且返回副本', () => {
  const r = resolveWords({ good: [], bad: null, common: ['  ', 'ok'] })
  assert.ok(r.good.length >= 4, 'good 为空应回退兜底')
  assert.ok(r.bad.length >= 4, 'bad 缺失应回退兜底')
  assert.deepEqual(r.common, ['ok'], '非空但含脏值时只保留干净项')

  const all = resolveWords(undefined)
  for (const k of ['good', 'bad', 'common']) assert.ok(all[k].length > 0)

  const src = { good: ['g'], bad: ['b'], common: ['c'] }
  const copy = resolveWords(src)
  copy.good.push('x')
  assert.equal(src.good.length, 1, '返回值应是副本')
})

test('luckRankOf：phi 分档 0–5，上界随 RP_BEST 取 99', () => {
  assert.equal(luckRankOf(99), 5, '99 是值域上界，与诸事皆宜特例同档')
  assert.equal(luckRankOf(100), 5, '越界值仍给最高档（不可达，仅防御）')
  for (const [rp, rank] of [[98, 4], [80, 4], [79, 3], [60, 3], [59, 2], [40, 2],
    [39, 1], [20, 1], [19, 0], [0, 0]]) {
    assert.equal(luckRankOf(rp), rank, `rp=${rp}`)
  }
})

test('fortuneSeed：数字 qqid 直接用；openid 用户派生稳定正整数种子（源的扩展）', () => {
  assert.equal(fortuneSeed({ qqid: 114514, key: '114514' }), 114514)
  const a = fortuneSeed({ key: 'openid-abc' })
  assert.equal(a, fortuneSeed({ key: 'openid-abc' }), 'openid 派生须稳定')
  assert.ok(Number.isInteger(a) && a > 0)
  assert.notEqual(a, fortuneSeed({ key: 'openid-xyz' }), '不同用户应得不同种子')
  assert.equal(fortuneSeed({}), 1, '空键回退 1')
})

test('fortuneText：逐字文案（推荐曲那两段与源一样直接拼接、中间无换行）', () => {
  const text = fortuneText(
    { rp: 19, good: ['g1', 'g2', 'g3', 'g4'], bad: ['b1', 'b2', 'b3', 'b4'],
      song: { song_id: 1234, song_name: '测试曲' } },
    'Hikari',
  )
  assert.equal(text, [
    '今日人品值：19',
    '宜 g1 / g2 / g3 / g4',
    '忌 b1 / b2 / b3 / b4',
    'Hikari Bot提醒您：打机时不要大力拍打或滑动哦',
    '今日推荐歌曲：ID.1234 - 测试曲',
  ].join('\n'))
})

test('规则：带命令头形态命中 fortune / jrrp / 今日舞萌', () => {
  const reg = new RegExp(new MaiFortune().rule[0].reg)
  for (const msg of ['#mai fortune', '#mai jrrp', '/mai jrrp', '#mai 今日舞萌', '#mai   fortune ']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['#mai fortunes', '#mai jrrp2', '#mai 今日人品', '#phi jrrp',
    '#mai fortune 14', '#mai']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
  // 尾随空白按本仓惯例容忍（\s*$）
  assert.match('#mai jrrp ', reg)
})

test('规则：免前缀形态命中 `#今日舞萌`（前缀可选），且不收他人命令', () => {
  const reg = new RegExp(new MaiFortuneSay().rule[0].reg)
  for (const msg of ['#今日舞萌', '/今日舞萌', '今日舞萌', '今日舞萌 ']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['今日舞萌了吗', '来看看今日舞萌', '#mai 今日舞萌', '#phi 今日舞萌', '今日舞萌运势']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('规则：两条今日舞萌规则互不吃（带头的走带头，裸词走免前缀）', () => {
  const head = new RegExp(new MaiFortune().rule[0].reg)
  const say = new RegExp(new MaiFortuneSay().rule[0].reg)
  for (const msg of ['#mai fortune', '#mai jrrp', '#mai 今日舞萌']) {
    assert.ok(head.test(msg) && !say.test(msg), `${msg} 应只被带头规则命中`)
  }
  for (const msg of ['#今日舞萌', '今日舞萌']) {
    assert.ok(!head.test(msg) && say.test(msg), `${msg} 应只被免前缀规则命中`)
  }
})

test('规则：免前缀规则放在 priority 1500 且 log:false（本仓口语约定）', () => {
  const say = new MaiFortuneSay()
  assert.equal(say.priority, 1500)
  assert.equal(say.rule[0].log, false)
  const head = new MaiFortune()
  assert.equal(head.priority, 100, '带命令头的仍是普通命令优先级')
})
