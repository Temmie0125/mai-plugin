/**
 * 上分推荐算法单测（lib/tableData.js getRiseScoreList；源 efa55a9 重写后的算法）
 * 纯合成数据，不依赖曲库/网络。
 *
 * 关键数值（ds=13.0，源 RISE_ACHIEVEMENT_LIST = [99, 99.5, 100, 100.5]）：
 *   compute_rating(13.0, 99,   israte) = floor(13 * 0.99  * 20.8) = 267  rate 'ss'
 *   compute_rating(13.0, 99.5, israte) = floor(13 * 0.995 * 21.1) = 272  rate 'ssp'
 *   compute_rating(13.0, 100,  israte) = floor(13 * 1.0   * 21.6) = 280  rate 'sss'
 *   compute_rating(13.0, 100.5,israte) = floor(13 * 1.005 * 22.4) = 292  rate 'sssp'
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getRiseScoreList } from '../lib/tableData.js'

const diff = (li, level, ds) => ({ level_index: li, level, level_value: ds, dx_score: 1000 })
const song = (id, diffs, type = null) => ({
  song_id: id, song_name: `曲${id}`, type: type ?? (id < 10000 ? 'sd' : 'dx'), difficulties: diffs,
})
/** 只关心 filter 的返回，故打桩一个原样返回的 filter（算法本身在本文件被验证） */
const listOf = (songs) => ({ filter: () => songs })
const rec = (songId, li, rating, level = '13', achievements = 99) =>
  ({ song_id: songId, level_index: li, level, rating, achievements })

/** 取前 k 个的确定性采样器（生产用随机，此处只为可断言） */
const det = (arr, k) => arr.slice(0, k)

/** 造一条满额的 B50 半边：n 条成绩、最低 rating = lowest */
const fullHalf = (type, lowest = 200) => {
  const n = type === 'dx' ? 15 : 35
  return Array.from({ length: n }, (_, i) => rec(1000 + i, 3, lowest + (n - 1 - i), '13'))
}

test('空 B50 → 空结果（源 `if not play_result: return [], 0`）', () => {
  assert.deepEqual(getRiseScoreList(new Map(), 'sd', [], null, null, { totalList: listOf([]) }),
    { list: [], lowestRa: 0 })
  assert.deepEqual(getRiseScoreList(new Map(), 'sd', undefined, null, null, { totalList: listOf([]) }),
    { list: [], lowestRa: 0 })
})

test('半边不满额 → lowestRa = 0（源 efa55a9：B50 没攒满，任何新成绩都可能进榜）', () => {
  const b50 = [rec(1, 3, 300, '13'), rec(2, 3, 200, '13')]  // sd 半边仅 2 条 < 35
  const { list, lowestRa } = getRiseScoreList(new Map(), 'sd', b50, '13', null,
    { totalList: listOf([song(100, [diff(3, '13', 13.0)])]), sample: det })
  assert.equal(lowestRa, 0, '不满额不得取末位 rating 当最低分')
  assert.equal(list.length, 1, '0 门槛下未玩过的谱面也产候选')
  assert.equal(list[0].rating, 267)
})

test('半边满额 → lowestRa = 该半边最低 rating（sd 35 / dx 15 两档容量）', () => {
  for (const [type, n] of [['sd', 35], ['dx', 15]]) {
    const b50 = fullHalf(type, 200)
    assert.equal(b50.length, n)
    const { lowestRa } = getRiseScoreList(new Map(), type, b50, '13', null,
      { totalList: listOf([]) })
    assert.equal(lowestRa, 200, `${type} 满额时取 min(rating)`)
    // 差一条不满 → 回落到 0
    const { lowestRa: short } = getRiseScoreList(new Map(), type, b50.slice(0, n - 1), '13', null,
      { totalList: listOf([]) })
    assert.equal(short, 0, `${type} 差一条不满额时最低分视为 0`)
  }
})

test('未游玩曲：取首个 new_ra - lowest_ra >= 目标涨幅 的档位', () => {
  const b50 = fullHalf('sd', 200)                     // lowest_ra = 200
  const target = song(100, [diff(3, '13', 13.0)])
  const { list, lowestRa } = getRiseScoreList(new Map(), 'sd', b50, '13', null,
    { totalList: listOf([target]), sample: det })
  assert.equal(lowestRa, 200)
  assert.equal(list.length, 1)
  assert.equal(list[0].rating, 267)          // 267-200=67 ≥ 1 → 首档 99% 即中
  assert.equal(list[0].achievements, 99)
  assert.equal(list[0].rate, 'ss')           // 源 rate=new_rate.lower()
  assert.equal(list[0].old_rating, 0)        // 未游玩 → 0
  assert.equal(list[0].old_achievements, 0)
  assert.equal(list[0].old_rate, 'D')        // 本地口径大写 'D'（渲染层 RANK_MAP 兜底）
})

test('已游玩曲（b50 命中）：old_ra 取 b50 侧 rating', () => {
  const b50 = [...fullHalf('sd', 200), rec(100, 3, 260, '13', 98.5)]
  const target = song(100, [diff(3, '13', 13.0)])
  const { list } = getRiseScoreList(new Map(), 'sd', b50, '13', 10,
    { totalList: listOf([target]), sample: det })
  assert.equal(list.length, 1)
  assert.equal(list[0].rating, 272)          // 267-260=7 < 10 跳过 → 272-260=12 ✔
  assert.equal(list[0].achievements, 99.5)
  assert.equal(list[0].old_rating, 260)
  assert.equal(list[0].old_achievements, 98.5)
  assert.equal(list[0].old_rate, 'D')        // 该记录无 rate → 回退 'D'
})

test('已游玩曲（仅全量命中）：old_ra = lowest_ra，且 new_ra ≤ 旧 rating 的候选被剔除', () => {
  const b50 = fullHalf('sd', 260)                     // lowest_ra = 260，不含曲目 100
  const old = new Map([['100-3', rec(100, 3, 300, '13', 98.5)]])
  const target = song(100, [diff(3, '13', 13.0)])
  const { list } = getRiseScoreList(old, 'sd', b50, '13', 10,
    { totalList: listOf([target]), sample: det })
  assert.deepEqual(list, [], '267/272/280 均 ≤ 旧 rating 300，且 292-260=32 ≥ 10 但 292 ≤ 300 → 全被剔除')
})

test('已游玩曲（仅全量命中）：new_ra 高于旧 rating 时可产候选，old 值取全量记录', () => {
  const b50 = fullHalf('sd', 260)
  const old = new Map([['100-3', {
    song_id: 100, level_index: 3, level: '13', rating: 270, achievements: 98.5, rate: 'ssp',
  }]])
  const target = song(100, [diff(3, '13', 13.0)])
  const { list } = getRiseScoreList(old, 'sd', b50, '13', 10,
    { totalList: listOf([target]), sample: det })
  assert.equal(list.length, 1)
  assert.equal(list[0].rating, 272)          // 272-260=12 ≥ 10 且 272 > 270 ✔（267-260=7 先被涨幅拦下）
  assert.equal(list[0].old_rating, 270)
  assert.equal(list[0].old_rate, 'ssp')      // 全量记录带 rate → 原样透传
})

test('逐谱面去重：同曲某难度已 AP 不再拉黑整曲，其余难度照常产候选', () => {
  const b50 = [rec(100, 3, 300, '13', 100.5), ...fullHalf('sd', 200).slice(1)]
  const target = song(100, [diff(3, '13', 13.0), diff(4, '13+', 13.6)])
  const { list } = getRiseScoreList(new Map(), 'sd', b50, '13', null,
    { totalList: listOf([target]), sample: det })
  // 难度 3 已 100.5% → 跳过；难度 4 未玩 → 产候选（旧算法按 song_id 整曲拉黑，此处应空）
  assert.equal(list.length, 1)
  assert.equal(list[0].level_index, 4)
})

test('宴谱（song_id >= 100000）被排除', () => {
  const b50 = fullHalf('sd', 200)
  const utage = song(100001, [diff(3, '13', 13.0)], 'dx')
  const { list } = getRiseScoreList(new Map(), 'sd', b50, '13', null,
    { totalList: listOf([utage]), sample: det })
  assert.deepEqual(list, [])
})

test('抽样上限 5 条，且按 level_value 降序展示（采样随机、展示有序）', () => {
  const b50 = fullHalf('sd', 200)
  const songs = [13.0, 13.1, 13.2, 13.3, 13.4, 13.5].map((ds, i) => song(100 + i, [diff(3, '13', ds)]))
  const { list } = getRiseScoreList(new Map(), 'sd', b50, '13', null,
    { totalList: listOf(songs), sample: (arr, k) => arr.slice(0, k) })
  assert.equal(list.length, 5, '最多 5 条')
  const dss = list.map(r => r.level_value)
  assert.deepEqual(dss, [...dss].sort((a, b) => b - a), '按 level_value 降序')
})

test('目标涨幅下限 1：score=0 / 负数都按 1 处理（源 max(score or 1, 1)）', () => {
  const b50 = fullHalf('sd', 291)
  const target = song(100, [diff(3, '13', 13.0)])
  for (const score of [0, -5]) {
    const { list } = getRiseScoreList(new Map(), 'sd', b50, '13', score,
      { totalList: listOf([target]), sample: det })
    assert.equal(list.length, 1, `score=${score} 应按 1 处理`)
    assert.equal(list[0].rating, 292)        // 292-291=1 ≥ 1 ✔（涨幅 0/-5 不会比这更宽）
  }
})

test('未给目标等级且半边满额时，目标谱面按 min_ds 区间筛选', () => {
  const b50 = fullHalf('sd', 200)
  let captured = null
  const probe = { filter: (opts) => { captured = opts; return [] } }
  getRiseScoreList(new Map(), 'sd', b50, null, 5, { totalList: probe })
  assert.ok(Array.isArray(captured.level_value), 'level 为空且满额时应下发定数区间')
  // min_ds = ceil((200 + 5) / (100.5/100*22.4) * 10) / 10 = ceil(9.106*10)/10 = 9.2
  assert.deepEqual(captured.level_value, [9.2, 10.2])
  assert.equal(captured.level, null)
})

test('未给目标等级但半边不满额时，不下发定数区间（lowestRa=0 算不出有意义的窗口）', () => {
  const b50 = [rec(1, 3, 300, '13'), rec(2, 3, 200, '13')]
  let captured = null
  const probe = { filter: (opts) => { captured = opts; return [] } }
  getRiseScoreList(new Map(), 'sd', b50, null, 5, { totalList: probe })
  assert.equal(captured.level_value, null, '不满额时 ds 必须为 null（源 efa55a9）')
})

test('给出目标等级时按 level 精确筛选（不下发定数区间）', () => {
  const b50 = fullHalf('sd', 200)
  let captured = null
  const probe = { filter: (opts) => { captured = opts; return [] } }
  getRiseScoreList(new Map(), 'sd', b50, '13', null, { totalList: probe })
  assert.equal(captured.level, '13')
  assert.equal(captured.level_value, null)
})

test('sd / dx 走不同版本池（dx=最新版本；sd=最新版本之前的全部）', async () => {
  const { ALL_VERSION, DX_CN_VERSION } = await import('../lib/constants.js')
  const vals = Object.values(DX_CN_VERSION)
  const newest = vals[vals.length - 1][vals[vals.length - 1].length - 1]
  const b50 = fullHalf('sd', 200)
  let captured = null
  const probe = { filter: (opts) => { captured = opts; return [] } }
  getRiseScoreList(new Map(), 'dx', b50, '13', null, { totalList: probe })
  assert.equal(captured.version_str, newest)
  getRiseScoreList(new Map(), 'sd', b50, '13', null, { totalList: probe })
  assert.deepEqual(captured.version_str, ALL_VERSION.slice(0, ALL_VERSION.indexOf(newest)))
})
