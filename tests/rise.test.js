/**
 * 上分推荐算法单测（lib/tableData.js getRiseScoreList，源 handler.py:200）
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

test('空 B50 → 空结果（源 `if not play_result: return [], 0`）', () => {
  assert.deepEqual(getRiseScoreList(new Map(), 'sd', [], null, null, { totalList: listOf([]) }),
    { list: [], lowestRa: 0 })
  assert.deepEqual(getRiseScoreList(new Map(), 'sd', undefined, null, null, { totalList: listOf([]) }),
    { list: [], lowestRa: 0 })
})

test('目标等级低于最低分曲等级 → 空结果', () => {
  // 最低分曲在 13（LEVEL_INDEX_MAP=18），目标 12（16）→ 18 > 16
  const b50 = [rec(1, 3, 300, '13'), rec(2, 3, 200, '13')]
  const out = getRiseScoreList(new Map(), 'sd', b50, '12', null, { totalList: listOf([song(100, [diff(3, '13', 13.0)])]) })
  assert.deepEqual(out, { list: [], lowestRa: 0 })
})

test('未游玩曲：取首个 new_ra > lowest_ra 的档位', () => {
  const b50 = [rec(1, 3, 300, '13'), rec(2, 3, 200, '13')]  // lowest_ra = 200
  const target = song(100, [diff(3, '13', 13.0)])
  const { list, lowestRa } = getRiseScoreList(new Map(), 'sd', b50, '13', null,
    { totalList: listOf([target]), sample: det })
  assert.equal(lowestRa, 200)
  assert.equal(list.length, 1)
  assert.equal(list[0].rating, 267)          // ach 99 即已超过 200
  assert.equal(list[0].achievements, 99)
  assert.equal(list[0].rate, 'ss')           // 源 rate=new_rate.lower()
  assert.equal(list[0].old_rating, 0)        // 未游玩 → 默认值
  assert.equal(list[0].old_rate, 'D')        // 源 RiseResult 默认 "D"
})

test('已游玩曲：取首个 new_ra - old_ra >= 目标涨幅 的档位', () => {
  const b50 = [rec(1, 3, 300, '13'), rec(2, 3, 200, '13')]
  const old = new Map([['100-3', rec(100, 3, 260, '13', 98.5)]])
  const target = song(100, [diff(3, '13', 13.0)])
  const { list } = getRiseScoreList(old, 'sd', b50, '13', 10,
    { totalList: listOf([target]), sample: det })
  assert.equal(list.length, 1)
  assert.equal(list[0].rating, 272)          // 267-260=7 < 10 跳过 → 272-260=12 ✔
  assert.equal(list[0].achievements, 99.5)
  assert.equal(list[0].old_rating, 260)
  assert.equal(list[0].old_achievements, 98.5)
  assert.equal(list[0].old_rate, 'D')        // 该记录无 rate → 回退 'D'
})

test('已游玩且成绩已达 100.5% 的曲目被整体忽略', () => {
  // ignored_song_ids 取自整份 play_result；被排除的是**候选曲目本身**（此处的 100）
  const b50 = [rec(100, 3, 300, '13', 100.5), rec(2, 3, 200, '13')]
  const target = song(100, [diff(3, '13', 13.0)])
  const { list, lowestRa } = getRiseScoreList(new Map(), 'sd', b50, '13', null,
    { totalList: listOf([target]), sample: det })
  assert.equal(lowestRa, 200, '最低分仍取末位那条')
  assert.deepEqual(list, [], '100.5% 的曲目应进 ignored_song_ids')
})

test('宴谱（song_id >= 100000）被排除', () => {
  const b50 = [rec(1, 3, 300, '13'), rec(2, 3, 200, '13')]
  const utage = song(100001, [diff(3, '13', 13.0)], 'dx')
  const { list } = getRiseScoreList(new Map(), 'sd', b50, '13', null,
    { totalList: listOf([utage]), sample: det })
  assert.deepEqual(list, [])
})

test('抽样上限 5 条，且按 level_value 降序展示（采样随机、展示有序）', () => {
  const b50 = [rec(1, 3, 300, '13'), rec(2, 3, 200, '13')]
  const songs = [13.0, 13.1, 13.2, 13.3, 13.4, 13.5].map((ds, i) => song(100 + i, [diff(3, '13', ds)]))
  const { list } = getRiseScoreList(new Map(), 'sd', b50, '13', null,
    { totalList: listOf(songs), sample: (arr, k) => arr.slice(0, k) })
  assert.equal(list.length, 5, '最多 5 条')
  const dss = list.map(r => r.level_value)
  assert.deepEqual(dss, [...dss].sort((a, b) => b - a), '按 level_value 降序')
})

test('未给目标等级时，目标谱面按 min_ds 区间筛选（level_value 传 [min_ds, min_ds+1]）', () => {
  const b50 = [rec(1, 3, 300, '13'), rec(2, 3, 200, '13')]
  let captured = null
  const probe = { filter: (opts) => { captured = opts; return [] } }
  getRiseScoreList(new Map(), 'sd', b50, null, 5, { totalList: probe })
  assert.ok(Array.isArray(captured.level_value), 'level 为空时应下发定数区间')
  // min_ds = ceil((200 + 5) / (100.5/100*22.4) * 10) / 10 = ceil(9.106*10)/10 = 9.2
  assert.deepEqual(captured.level_value, [9.2, 10.2])
  assert.equal(captured.level, null)
})

test('给出目标等级时按 level 精确筛选（不下发定数区间）', () => {
  const b50 = [rec(1, 3, 300, '13'), rec(2, 3, 200, '13')]
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
  const b50 = [rec(1, 3, 300, '13'), rec(2, 3, 200, '13')]
  let captured = null
  const probe = { filter: (opts) => { captured = opts; return [] } }
  getRiseScoreList(new Map(), 'dx', b50, '13', null, { totalList: probe })
  assert.equal(captured.version_str, newest)
  getRiseScoreList(new Map(), 'sd', b50, '13', null, { totalList: probe })
  assert.deepEqual(captured.version_str, ALL_VERSION.slice(0, ALL_VERSION.indexOf(newest)))
})
