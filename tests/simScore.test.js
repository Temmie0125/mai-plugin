/**
 * 歌50 模拟成绩单测（lib/simScore.js）
 *
 * 全部离线：不碰 mai 单例、不触网、不落盘。
 * 断言的是「token 串 → 模拟规格 → 合成成绩」这一层，不含出图（渲染冒烟见 render-variantb50.mjs）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SIM_ERROR_TEXT, THEORY_ACH, defaultLevelIndex, simErrorText, simRecord, splitSimTokens,
} from '../lib/simScore.js'
import { computeRating, dxStar } from '../lib/calc.js'
import { RANK_MAP } from '../lib/constants.js'
import { repeatSpec } from '../lib/variantSpec.js'
import { variantBest50 } from '../lib/variantB50.js'
import { SD_SLOTS, DX_SLOTS } from '../lib/b50Core.js'

/** 造一首曲：五项难度，定数按 levels 递增 */
const song = ({ song_id = 799, song_name = '白潘', type = 'DX', levels = [5, 8, 11, 13.5, 14.5], dxScore = 2227 } = {}) => ({
  song_id,
  song_name,
  type,
  difficulties: levels.map((lv, i) => ({
    level_index: i, level: String(lv), level_value: lv, note_designer: '-', dx_score: dxScore,
  })),
})

/**
 * 一步到位：解析 + 合成。
 * 难度色由 apps 层解析（那是 apps/score.js 的职责，纯单测不引它），故这里用 li 显式给；
 * li 省略时走模拟模式的默认规则（该曲定数最高的谱面）。
 */
function build(raw, s = song(), li = null) {
  const { sim, error } = splitSimTokens(raw)
  if (error) return { error }
  const idx = li ?? defaultLevelIndex(s)
  return simRecord({
    song: s, levelIndex: idx, levelValue: s.difficulties[idx].level_value, dxMax: s.difficulties[idx].dx_score, sim,
  })
}

// ---------------------------------------------------------------- 剥离与归类

test('splitSimTokens：无模拟参数时原样退回曲名', () => {
  for (const raw of ['白潘', '紫茄子', 'QZKago Requiem', '799', '799 紫', '红 799']) {
    const r = splitSimTokens(raw)
    assert.equal(r.sim, null, `不应识别为模拟：${raw}`)
    assert.equal(r.error, null)
    assert.deepEqual(r.rest, raw.split(' '), `曲名 token 应原样保留：${raw}`)
  }
})

test('splitSimTokens：模拟参数从右端剥离，顺序任意', () => {
  const cases = [
    ['白潘 理论', ['白潘']],
    ['白潘 理论 FDX+ 5★ AP+', ['白潘']],
    ['白潘 AP+ 5★ FDX+ 理论', ['白潘']],
    ['799 紫 SS+', ['799', '紫']],
    ['紫 799 SS+', ['紫', '799']],
    ['白潘 99.00 FDX dx1145 AP', ['白潘']],
  ]
  for (const [raw, rest] of cases) {
    const r = splitSimTokens(raw)
    assert.equal(r.error, null, `不应报错：${raw}`)
    assert.ok(r.sim, `应识别为模拟：${raw}`)
    assert.deepEqual(r.rest, rest, `剩余 token 应为曲名部分：${raw}`)
  }
})

test('越界裸数字不算模拟 token —— 保住 `紫 799` / `799 紫` 这类既有写法', () => {
  // 难度色在前、id 在后是 parseSong50Args 明确支持的既有写法，不能被 799 的「越界」拦下
  for (const raw of ['紫 799', '799 紫', '红 799']) {
    const r = splitSimTokens(raw)
    assert.equal(r.error, null, raw)
    assert.equal(r.sim, null, raw)
    assert.deepEqual(r.rest, raw.split(' '), raw)
  }
  // `紫 799 SS+`：评级照剥，id 留在曲名侧
  const c = splitSimTokens('紫 799 SS+')
  assert.equal(c.error, null)
  assert.equal(c.sim.ach, 99.5)
  assert.deepEqual(c.rest, ['紫', '799'])

  // 裸数字写了 DX 分：剥不到达成率/评级 ⇒ needScore，文案里必须给出 dx 前缀的提示
  const bad = splitSimTokens('白潘 99.00 FDX 1145 AP')
  assert.equal(bad.error?.code, 'needScore')
  assert.match(simErrorText(bad.error, { cmdHead: 'mai' }), /dx1145/)
})

test('splitSimTokens：至少留一个 token 当曲名（`#mai 歌50 D` 不被吃空）', () => {
  const r = splitSimTokens('D')
  assert.equal(r.sim, null)
  assert.deepEqual(r.rest, ['D'])
})

// ---------------------------------------------------------------- 达成率与评级

test('评级 → 该档**起算线**（SS+=99.5 而非 100；SSS=100 而非 100.5）', () => {
  const table = [
    ['SSS+', 100.5], ['SSS', 100], ['SS+', 99.5], ['SS', 99], ['S+', 98], ['S', 97],
    ['AAA', 94], ['AA', 90], ['A', 80], ['BBB', 75], ['BB', 70], ['B', 60], ['C', 50], ['D', 0],
  ]
  for (const [token, ach] of table) {
    const { sim, error } = splitSimTokens(`白潘 ${token}`)
    assert.equal(error, null, `应可解析：${token}`)
    assert.equal(sim.ach, ach, `${token} 的起算线`)
  }
  // 社区中文叫法
  for (const t of ['鸟加', '鸟+', '鸟家']) assert.equal(splitSimTokens(`白潘 ${t}`).sim.ach, 100.5, t)
  assert.equal(splitSimTokens('白潘 鸟').sim.ach, 100)
  // 大小写折叠
  for (const t of ['sss+', 'Sss+', 'sssp']) assert.equal(splitSimTokens(`白潘 ${t}`).sim.ach, 100.5, t)
})

test('达成率数值：容忍尾随 %，不带小数点的整数也是达成率', () => {
  for (const [token, ach] of [['100.1145', 100.1145], ['100.1145%', 100.1145], ['99.00', 99], ['99%', 99]]) {
    const { sim, error } = splitSimTokens(`白潘 ${token}`)
    assert.equal(error, null, token)
    assert.equal(sim.ach, ach, token)
  }
})

test('理论 / AP+：等价，且必然 AP+', () => {
  for (const t of ['理论', 'AP+', 'ap+']) {
    assert.equal(splitSimTokens(`白潘 ${t}`).sim.ach, THEORY_ACH, t)
  }
  // 理论 + 非 AP+ 的标志 → 静默强制 app
  assert.equal(splitSimTokens('白潘 理论 FC+').sim.fc, 'app')
  assert.equal(splitSimTokens('白潘 101.0000 AP').sim.fc, 'app')
  // 100.9999 不是理论 ⇒ 不做强制
  const near = splitSimTokens('白潘 100.9999 FC+')
  assert.equal(near.sim.theory, false)
  assert.equal(near.sim.fc, 'fcp')
  // 显式达成率优先于 AP+ 的字面含义（娱乐向：允许不自洽的组合）
  const mixed = splitSimTokens('白潘 99.00 AP+')
  assert.equal(mixed.sim.ach, 99)
  assert.equal(mixed.sim.fc, 'app')
})

test('AP+ 单独出现 = 理论；只给修饰不给达成率/评级 → needScore', () => {
  const ap = splitSimTokens('白潘 AP+')
  assert.equal(ap.error, null)
  assert.equal(ap.sim.ach, THEORY_ACH)
  assert.equal(ap.sim.fc, 'app')

  for (const raw of ['白潘 FDX+ 5星', '白潘 dx1145', '白潘 FC+', '白潘 1星']) {
    assert.equal(splitSimTokens(raw).error?.code, 'needScore', raw)
  }
  assert.match(simErrorText({ code: 'needScore' }, { cmdHead: 'mai' }), /#mai 歌50 白潘 理论/)
})

// ---------------------------------------------------------------- 默认值

test('默认值：理论走全最高档，其余走常规档', () => {
  const th = splitSimTokens('白潘 理论').sim
  assert.deepEqual([th.fs, th.dx.value, th.dx.mode, th.fc], ['fdxp', 5, 'star', 'app'])

  const nm = splitSimTokens('白潘 99.00').sim
  assert.deepEqual([nm.fs, nm.dx.value, nm.dx.mode, nm.fc], ['fdx', 3, 'star', 'fcp'])
})

test('同步标识：八个 token → fs 字段（与 constants.SYNC_MAP 同一套取值）', () => {
  const table = [
    ['FDX+', 'fdxp'], ['FDX', 'fdx'], ['FSD+', 'fsdp'], ['FSD', 'fsd'],
    ['FS+', 'fsp'], ['FS', 'fs'], ['SYNC', 'sync'], ['单刷', null],
  ]
  for (const [token, fs] of table) {
    const { sim, error } = splitSimTokens(`白潘 99.00 ${token}`)
    assert.equal(error, null, token)
    assert.equal(sim.fs, fs, token)
  }
  // 大小写折叠
  assert.equal(splitSimTokens('白潘 99.00 fdx+').sim.fs, 'fdxp')
})

test('FC/AP 标志：四个 token → fc 字段', () => {
  for (const [token, fc] of [['FC', 'fc'], ['FC+', 'fcp'], ['AP', 'ap'], ['AP+', 'app']]) {
    assert.equal(splitSimTokens(`白潘 99.00 ${token}`).sim.fc, fc, token)
  }
})

// ---------------------------------------------------------------- DX 分数

test('星数 → DX 分数：图上显示的星数必须等于输入（含整除边界）', () => {
  // dxMax=1000 时 85/90/93/95/97 全是整数 ⇒ 恰好落在 dxStar 的 `<=` 边界上（判低一档），
  // 靠 resolveDx 的反查 +1 兜住。2227 是奇数，走另一条路径。
  for (const dxScore of [1000, 2227, 300]) {
    for (const n of [1, 2, 3, 4, 5]) {
      // `N★` 与 `N星` 等价（横幅文案用的就是 ★，可直接复制回来当命令）
      for (const unit of ['星', '★']) {
        const built = build(`白潘 99.00 ${n}${unit}`, song({ dxScore }))
        assert.equal(built.error, undefined, `${dxScore} / ${n}${unit}`)
        assert.equal(built.record.dx_star, n, `dx_star：${dxScore} / ${n}${unit}`)
        assert.equal(dxStar((built.record.dx_score / dxScore) * 100), n,
          `渲染层反推的星数应等于输入：dxMax=${dxScore} / ${n}${unit}（dx=${built.record.dx_score}）`)
      }
    }
    // 单调：星数越高 DX 分数越高
    const scores = [1, 2, 3, 4, 5].map(n => build(`白潘 99.00 ${n}星`, song({ dxScore })).record.dx_score)
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i] > scores[i - 1])
  }
})

test('DX 分数：绝对分 / 百分比，越界各自报错', () => {
  const abs = build('白潘 理论 dx1145', song({ dxScore: 2227 }))
  assert.equal(abs.record.dx_score, 1145)

  const pct = build('白潘 理论 dx99%', song({ dxScore: 1000 }))
  assert.equal(pct.record.dx_score, 990)

  assert.equal(build('白潘 理论 dx9999', song({ dxScore: 2227 })).error?.code, 'dxOver')
  assert.match(simErrorText({ code: 'dxOver', detail: { value: 9999, dxMax: 2227 } }), /2227/)

  assert.equal(splitSimTokens('白潘 理论 dx150%').error?.code, 'dxPct')
})

test('物量缺失（曲库异常）→ noNotes，不放行一个星数与图对不上的成绩', () => {
  const s = song({ dxScore: 0 })
  assert.equal(build('白潘 理论', s).error?.code, 'noNotes')
  assert.equal(build('白潘 理论 dx100', s).error?.code, 'noNotes')
})

// ---------------------------------------------------------------- 合成成绩

test('合成成绩：字段自洽（rating / rate / 定数 / 难度）', () => {
  const s = song()
  const li = 3 // 紫谱（难度色在 apps 层解析，这里直接给下标）
  const built = build('白潘 紫 理论', s, li)
  const r = built.record
  assert.equal(r.level_index, li)
  assert.equal(r.level_value, s.difficulties[li].level_value)
  assert.equal(r.achievements, 101)
  assert.equal(r.rating, computeRating(r.level_value, 101))
  // rate 必须是小写 RANK_SP 键，渲染层才会查到图标（views.js 的 RANK_MAP[info.rate]）
  assert.equal(r.rate, 'sssp')
  assert.ok(RANK_MAP[r.rate], 'rate 应能映射到评级图标')
  assert.equal(built.summary, '101.0000% FDX+ 5★ AP+')
})

test('横幅文案逐字', () => {
  assert.equal(build('白潘 理论').summary, '101.0000% FDX+ 5★ AP+')
  assert.equal(build('白潘 99.00').summary, '99.0000% FDX 3★ FC+')
  assert.equal(build('白潘 99.00 单刷 1星 FC+').summary, '99.0000% 单刷 1★ FC+')
  assert.equal(build('白潘 理论 FSD').summary, '101.0000% FSD 5★ AP+')
})

test('歌50 接线：模拟成绩重复填充 35+15，合计 = 50 × 该谱 Rating', () => {
  const s = song()
  const { record } = build('白潘 理论', s, 3)
  const spec = repeatSpec({ song_id: s.song_id, level_index: 3 }, '歌50 · 白潘', record)
  // 传空 records 也成立 —— 模拟路径**完全不读**玩家成绩
  const { best50, total, candidates } = variantBest50([], spec, { totalList: { byId: id => (id === s.song_id ? s : null) } })
  assert.equal(candidates, 1)
  assert.equal(best50.sd.length, SD_SLOTS)
  assert.equal(best50.dx.length, DX_SLOTS)
  assert.equal(total, record.rating * 50)
})

// ---------------------------------------------------------------- 默认难度

test('defaultLevelIndex：取定数最高的谱面，跳过占位；平手取更小下标', () => {
  assert.equal(defaultLevelIndex(song()), 4)
  // 高难度位是占位（level_value 0）→ 退到有定数的最高的那一档
  const gap = song()
  gap.difficulties[4].level_value = 0
  assert.equal(defaultLevelIndex(gap), 3)
  // 平手：紫优先于白
  const tie = song({ levels: [5, 8, 11, 14, 14] })
  assert.equal(defaultLevelIndex(tie), 3)
  assert.equal(defaultLevelIndex({ difficulties: [] }), null)
  assert.equal(defaultLevelIndex(null), null)
})

test('该难度无定数 → noLevel 文案', () => {
  const s = song()
  s.difficulties[4].level_value = 0
  const { sim } = splitSimTokens('白潘 理论')
  const out = simRecord({ song: s, levelIndex: 4, levelValue: 0, dxMax: 2227, sim })
  assert.equal(out.error?.code, 'noLevel')
  assert.match(simErrorText(out.error, {}), /白潘/)
})

// ---------------------------------------------------------------- 重复指定

test('同槽位重复指定 → dup', () => {
  const cases = [
    ['白潘 99.00 98.00', '达成率'],
    ['白潘 SS+ SSS', '评级'],
    ['白潘 理论 99.00', '达成率'],
    ['白潘 99.00 FDX FDX+', '同步标识'],
    ['白潘 99.00 dx1145 dx99%', 'DX 分数'],
    ['白潘 99.00 FC AP', 'FC/AP 标志'],
  ]
  for (const [raw, slot] of cases) {
    const r = splitSimTokens(raw)
    assert.equal(r.error?.code, 'dup', raw)
    assert.equal(r.error.detail.slot, slot, raw)
    assert.match(simErrorText(r.error, {}), new RegExp(slot))
  }
})

test('SIM_ERROR_TEXT 的每个函式条目都能渲染出非空文案', () => {
  for (const [code, t] of Object.entries(SIM_ERROR_TEXT)) {
    const text = typeof t === 'function'
      ? t({ songName: 'X', value: 1, dxMax: 2, tokens: ['t'] })
      : t
    assert.ok(typeof text === 'string' && text.length > 0, code)
  }
})
