/**
 * 表格族数据整形单测（lib/tableData.js）
 * 纯函数，无需曲库/网络 —— 与 tableLayout.test.js 配对构成本批主要单测面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calcAchievementsFc, processRatingTableData } from '../lib/tableData.js'
import { STATISTICS_KEYS } from '../lib/constants.js'

/** 造一条成绩（level 与 level_index 显式给定，便于按 label 过滤） */
const rec = (songId, li, ach, { level = '13', ds = 13.0, fc = null, fs = null } = {}) =>
  ({ song_id: songId, level_index: li, level, level_value: ds, achievements: ach, fc, fs })

test('统计初值：16 个 STATISTICS_KEYS 全为 0', () => {
  const { statistics, playedMap } = processRatingTableData('13', [])
  assert.deepEqual(Object.keys(statistics), [...STATISTICS_KEYS])
  assert.ok(Object.values(statistics).every(v => v === 0))
  assert.equal(playedMap.size, 0)
})

test('按 level 字面过滤（源 _d.level != self.rating；不用 level_value）', () => {
  const { statistics, playedMap } = processRatingTableData('13', [
    rec(1, 3, 100.5, { level: '13' }),
    rec(2, 3, 100.5, { level: '13+' }),   // 同定数区间但标签不同 → 必须排除
    rec(3, 3, 100.5, { level: '12' }),
  ])
  assert.equal(playedMap.size, 1)
  assert.equal(statistics.clear, 1)
})

test('clear：仅 achievements >= 80 计入', () => {
  const { statistics } = processRatingTableData('13', [
    rec(1, 3, 79.9999), rec(2, 3, 80), rec(3, 3, 100.5),
  ])
  assert.equal(statistics.clear, 2)
})

test('评价档位：按 RANK_SP 末 6 档累计（315/236… 语义）', () => {
  // 源 compute_rating 的档位边界：<97 AAA｜<98 S｜<99 Sp｜<99.5 SS｜<100 SSp｜<100.5 SSS｜≥100.5 SSSp
  // 故 AAA 及以下不进任何 rank 档
  const below = processRatingTableData('13', [rec(1, 3, 96.9)]).statistics
  for (const k of ['s', 'sp', 'ss', 'ssp', 'sss', 'sssp']) assert.equal(below[k], 0, `96.9(AAA) 不应计入 ${k}`)

  // S（97~98）→ 只计入 s
  const s = processRatingTableData('13', [rec(1, 3, 97.5)]).statistics
  assert.deepEqual([s.s, s.sp, s.ss, s.ssp, s.sss, s.sssp], [1, 0, 0, 0, 0, 0])

  // Sp（98~99）→ s、sp 递增
  const sp = processRatingTableData('13', [rec(1, 3, 98.0)]).statistics
  assert.deepEqual([sp.s, sp.sp, sp.ss, sp.ssp, sp.sss, sp.sssp], [1, 1, 0, 0, 0, 0])

  // SSS+（≥100.5）→ 6 档全计
  const top = processRatingTableData('13', [rec(1, 3, 100.5)]).statistics
  assert.deepEqual([top.s, top.sp, top.ss, top.ssp, top.sss, top.sssp], [1, 1, 1, 1, 1, 1])
})

test('FC：按 COMBO_SP 序累计（fc→ap→app 递进）', () => {
  const fc = processRatingTableData('13', [rec(1, 3, 100.5, { fc: 'fc' })]).statistics
  assert.deepEqual([fc.fc, fc.fcp, fc.ap, fc.app], [1, 0, 0, 0])

  const ap = processRatingTableData('13', [rec(1, 3, 100.5, { fc: 'ap' })]).statistics
  assert.deepEqual([ap.fc, ap.fcp, ap.ap, ap.app], [1, 1, 1, 0])

  const app = processRatingTableData('13', [rec(1, 3, 100.5, { fc: 'app' })]).statistics
  assert.deepEqual([app.fc, app.fcp, app.ap, app.app], [1, 1, 1, 1])
})

test('FS：sync 单列，其余按 SYNC_D_SP 序累计', () => {
  const sync = processRatingTableData('13', [rec(1, 3, 100.5, { fs: 'sync' })]).statistics
  assert.equal(sync.sync, 1)
  assert.deepEqual([sync.fs, sync.fsp, sync.fsd, sync.fsdp], [0, 0, 0, 0])

  const fsd = processRatingTableData('13', [rec(1, 3, 100.5, { fs: 'fsd' })]).statistics
  assert.equal(fsd.sync, 0)
  assert.deepEqual([fsd.fs, fsd.fsp, fsd.fsd, fsd.fsdp], [1, 1, 1, 0])
})

test('playedMap：song_id → level_index → {achievements, level, fc}', () => {
  const { playedMap } = processRatingTableData('13', [rec(7, 2, 99.1, { fc: 'fc' }), rec(7, 3, 100.0)])
  const song = playedMap.get(7)
  assert.equal(song.size, 2)
  assert.deepEqual(song.get(2), { achievements: 99.1, level: '13', fc: 'fc' })
  assert.equal(song.get(3).achievements, 100.0)
})

// 源判定是 `count == lvlist_num`（**恰好等于**总数 = 全员达标）才进档，否则 break；
// 故档位语义是「全员连续达标到第几档」，一人掉队即封顶。
//
// ⚠️ 阈值与档位的对齐关系是本函数正确性的关键：
//   ACHIEVEMENT_LIST[-6:] == [97, 98, 99, 99.5, 100, 100.5]
//   恰好与 RANK_SP[-6:]     == ['s','sp','ss','ssp','sss','sssp'] 一一对应，
//   这正是绘制侧能安全用 `RANK_MAP[RANK_SP[-6:][r]]` 取图标的原因。
test('calcAchievementsFc：非 plan 走 ACHIEVEMENT_LIST 末 6 档', () => {
  assert.equal(calcAchievementsFc([96, 96, 96], 3, false), -1)  // 全员 AAA → 首档(97)即不满
  assert.equal(calcAchievementsFc([97, 97, 97], 3, false), 0)   // 全员 ≥97 → 档0；98 掉队
  assert.equal(calcAchievementsFc([94, 97, 98], 3, false), -1)  // 94 拖后腿 → 首档就不满
  assert.equal(calcAchievementsFc([100.5, 100.5, 100.5], 3, false), 5)
  // 逐档取满 6 档：每档都要求「全员 ≥ 该档阈值」
  assert.equal(calcAchievementsFc([100.5, 100.5, 100.5, 100.5, 100.5, 100.5], 6, false), 5)
  assert.equal(calcAchievementsFc([100.5, 100.5, 100.5, 100.5, 100.5, 100.4], 6, false), 4) // 末位差 0.1 卡在档4
  assert.equal(calcAchievementsFc([100.5, 100.5, 100.5, 100.5, 99.9, 100.5], 6, false), 3) // 卡在 99.5 档
})

test('calcAchievementsFc：plan 走 range(4)，入参为 COMBO_SP 下标', () => {
  assert.equal(calcAchievementsFc([2, 2, 2], 3, true), 2)    // 全 ap（下标2）→ 档2
  assert.equal(calcAchievementsFc([0, 0, 0], 3, true), 0)
  assert.equal(calcAchievementsFc([3, 3, 3], 3, true), 3)
  assert.equal(calcAchievementsFc([3, 2, 3], 3, true), 2)    // 全员 ≥2 → 档2；档3 掉队
  assert.equal(calcAchievementsFc([3, 1, 3], 3, true), 1)    // 档2 掉队 → 封顶档1
  assert.equal(calcAchievementsFc([3, 3], 3, true), -1)      // 数量不足 → 首档即不满
})

test('calcAchievementsFc：数量不足总数时不返档（-1）', () => {
  assert.equal(calcAchievementsFc([100.5, 100.5], 3, false), -1)
  assert.equal(calcAchievementsFc([], 0, false), 5, '0 张谱面时阈值全满足（源边界）')
})
