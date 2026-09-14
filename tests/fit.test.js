/**
 * 拟合 B50 计算单测（设计《拟合b50实现设计.md》§4 / §9）
 *
 * 全部离线：曲库经 deps 注入假对象，不碰 mai 单例、不触网、不落盘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fitBest50, SD_SLOTS, DX_SLOTS } from '../lib/fit.js'
import { computeRating } from '../lib/calc.js'

/**
 * 造假曲库：specs = { song_id, isnew, fit_diff?, level_index? }
 * stats 只挂在指定难度位（默认 3）上，其余难度位 stats 为 null。
 */
function mkLib(specs) {
  const map = new Map()
  for (const { song_id, isnew, fit_diff = null, level_index = 3 } of specs) {
    const difficulties = Array.from({ length: 5 }, (_, i) => ({
      level_index: i,
      level: '13',
      level_value: 13,
      stats: i === level_index && fit_diff != null ? { fit_diff } : null,
    }))
    map.set(song_id, { song_id, isnew, difficulties })
  }
  return { byId: id => map.get(id) ?? null }
}

/** 造成绩；rating 故意填错值以证明会被拟合口径覆写 */
function rec(song_id, achievements = 100.5, level_index = 3, extra = {}) {
  return {
    song_id,
    level_index,
    achievements,
    song_name: `S${song_id}`,
    level: '13',
    level_value: 13,
    type: 'SD',
    rating: 999,
    rate: 'sssp',
    fc: 'ap',
    fs: 'fsd',
    dx_score: 1000,
    ...extra,
  }
}

/** 达成率 100.5（baseRa 22.4）下 fit_diff → 拟合 rating */
const fitRa = ds => computeRating(ds, 100.5)

test('isnew 分池：true → B15 池，false → B35 池（SD/DX 不是分池依据）', () => {
  // 两首歌 type 都写成 SD，只有 isnew 不同 —— 证明分池看 isnew 而非 type
  const lib = mkLib([
    { song_id: 1, isnew: false, fit_diff: 13.0 },
    { song_id: 2, isnew: true, fit_diff: 13.0 },
  ])
  const { best50, fitTotal, candidates } = fitBest50([rec(1), rec(2)], { totalList: lib })
  assert.deepEqual(best50.sd.map(x => x.song_id), [1], 'isnew=false 进 35 位池')
  assert.deepEqual(best50.dx.map(x => x.song_id), [2], 'isnew=true 进 15 位池')
  assert.equal(best50.sd_total, fitRa(13.0))
  assert.equal(best50.dx_total, fitRa(13.0))
  assert.equal(fitTotal, best50.sd_total + best50.dx_total)
  assert.equal(candidates, 2)
})

test('35/15 截断与 totals：各池取 rating 前 N，排序降序', () => {
  const oldSpecs = Array.from({ length: 40 }, (_, i) => ({ song_id: 1000 + i, isnew: false, fit_diff: 10 + i * 0.1 }))
  const newSpecs = Array.from({ length: 20 }, (_, i) => ({ song_id: 2000 + i, isnew: true, fit_diff: 10 + i * 0.1 }))
  const lib = mkLib([...oldSpecs, ...newSpecs])
  // 入参按 song_id 升序，出参应为 rating 降序
  const records = [...oldSpecs, ...newSpecs].map(s => rec(s.song_id))
  const { best50, candidates } = fitBest50(records, { totalList: lib })

  assert.equal(best50.sd.length, SD_SLOTS, `B35 应恰好 ${SD_SLOTS} 条`)
  assert.equal(best50.dx.length, DX_SLOTS, `B15 应恰好 ${DX_SLOTS} 条`)
  assert.equal(candidates, 60, 'candidates 计全部参与排序的谱面，非截断后的条数')

  // 最高的 35 张 = i=5..39，最低的 i=0..4 被挤出
  const expSd = Array.from({ length: SD_SLOTS }, (_, k) => 1000 + (39 - k))
  const expDx = Array.from({ length: DX_SLOTS }, (_, k) => 2000 + (19 - k))
  assert.deepEqual(best50.sd.map(x => x.song_id), expSd)
  assert.deepEqual(best50.dx.map(x => x.song_id), expDx)

  const expSdTotal = expSd.reduce((a, id) => a + fitRa(10 + (id - 1000) * 0.1), 0)
  const expDxTotal = expDx.reduce((a, id) => a + fitRa(10 + (id - 2000) * 0.1), 0)
  assert.equal(best50.sd_total, expSdTotal)
  assert.equal(best50.dx_total, expDxTotal)
})

test('跳过：宴谱 / 曲库未收录 / 无 stats / fit_diff 非正', () => {
  const lib = mkLib([
    { song_id: 100001, isnew: true, fit_diff: 14.0 },   // 宴谱：曲库里**有**且定数有效，仍须排除（D8 优先）
    { song_id: 3000, isnew: false, fit_diff: null },    // 无 stats
    { song_id: 3001, isnew: false, fit_diff: 0 },       // 有 stats 但 fit_diff=0（实测 7 张属此类）
    { song_id: 3002, isnew: false, fit_diff: -1 },      // 负值同为非正数
    { song_id: 3003, isnew: false },                    // stats 字段整个缺失
  ])
  const records = [rec(100001), rec(3000), rec(3001), rec(3002), rec(3003), rec(9999)]
  const { best50, fitTotal, candidates } = fitBest50(records, { totalList: lib })
  assert.equal(candidates, 0, '9999 曲库未收录，其余四种被规则跳过')
  assert.deepEqual(best50.sd, [])
  assert.deepEqual(best50.dx, [])
  assert.equal(fitTotal, 0)
})

test('难度位越界：level_index 超出 difficulties 长度 → 跳过', () => {
  const lib = mkLib([{ song_id: 1, isnew: false, fit_diff: 13.0 }])
  const { candidates } = fitBest50([rec(1, 100.5, 9)], { totalList: lib })
  assert.equal(candidates, 0)
})

test('floor 口径锁值（需求文档样例）', () => {
  // fit_diff = 4.0895606834601415, ach = 100.5 → floor(4.0895… × 1.005 × 22.4) = 92
  const lib = mkLib([{ song_id: 4000, isnew: false, fit_diff: 4.0895606834601415 }])
  const { best50 } = fitBest50([rec(4000, 100.5)], { totalList: lib })
  assert.equal(best50.sd.length, 1)
  assert.equal(best50.sd[0].rating, 92)
  assert.equal(best50.sd_total, 92)
  // 精确拟合定数原样保留在 level_value 上（供出图显示 2 位小数）
  assert.equal(best50.sd[0].level_value, 4.0895606834601415)
  // 同一曲目换达成率：100 → floor(4.0895…×1.0×22.4) = 88（非 100.5 档 baseRa 22.4 不变）
  assert.equal(computeRating(4.0895606834601415, 100), 88)
})

test('同分稳定性：Array.sort 稳定，同 rating 保持入参顺序', () => {
  const lib = mkLib([
    { song_id: 5000, isnew: false, fit_diff: 13.0 },
    { song_id: 5001, isnew: false, fit_diff: 13.0 },
    { song_id: 5002, isnew: false, fit_diff: 13.0 },
  ])
  const { best50 } = fitBest50([rec(5002), rec(5000), rec(5001)], { totalList: lib })
  assert.deepEqual(best50.sd.map(x => x.song_id), [5002, 5000, 5001])
})

test('覆写口径：只改 level_value / rating，其余字段保留真实值', () => {
  const lib = mkLib([{ song_id: 6000, isnew: false, fit_diff: 12.5 }])
  const { best50 } = fitBest50(
    [rec(6000, 99.1234, 3, { fc: 'app', fs: 'fsdp', dx_score: 1234, rate: 'sss' })],
    { totalList: lib },
  )
  const item = best50.sd[0]
  assert.equal(item.level_value, 12.5, '★ 覆写为拟合定数')
  assert.equal(item.rating, computeRating(12.5, 99.1234), '★ 覆写为拟合 rating')
  assert.equal(item.achievements, 99.1234, '达成率保留真实值')
  assert.equal(item.fc, 'app')
  assert.equal(item.fs, 'fsdp')
  assert.equal(item.rate, 'sss')
  assert.equal(item.dx_score, 1234)
  assert.equal(item.song_name, 'S6000')
  assert.equal(item.type, 'SD', '经 Best50 工厂归一后 type 仍为大写')
})

test('D2 边界：缺失全在旧版本池 ⇒ 不影响 B15 池（§4.3 实测结论）', () => {
  const newSpecs = Array.from({ length: 20 }, (_, i) => ({ song_id: 2000 + i, isnew: true, fit_diff: 12 + i * 0.1 }))
  const oldNoStats = [
    { song_id: 7000, isnew: false, fit_diff: null },
    { song_id: 7001, isnew: false, fit_diff: null },
    { song_id: 7002, isnew: false, fit_diff: null },
  ]
  const lib = mkLib([...newSpecs, ...oldNoStats])
  const records = [...newSpecs.map(s => rec(s.song_id)), ...oldNoStats.map(s => rec(s.song_id))]
  const { best50, candidates } = fitBest50(records, { totalList: lib })
  assert.equal(candidates, 20, '旧池 3 张被 D2 剔除，其中 2 张会进 35 位的候选')
  assert.equal(best50.sd.length, 0, '旧池无有效拟合定数 → B35 为空')
  assert.equal(best50.dx.length, DX_SLOTS, 'B15 池不受旧池缺失影响')
})

test('退化入参：空成绩 / 空曲库 / 未注入 deps 均不抛错', () => {
  for (const [records, deps] of [
    [[], { totalList: mkLib([]) }],
    [[rec(1)], {}],
    [[rec(1)], undefined],
    [null, { totalList: mkLib([{ song_id: 1, isnew: false, fit_diff: 13 }]) }],
    [undefined, undefined],
  ]) {
    const { best50, fitTotal, candidates } = fitBest50(records, deps)
    assert.equal(candidates, 0)
    assert.equal(fitTotal, 0)
    assert.deepEqual(best50, { sd_total: 0, dx_total: 0, sd: [], dx: [] })
  }
})

test('不足 35/15 时按实际条数返回，totals 为实际之和', () => {
  const lib = mkLib([
    { song_id: 1, isnew: false, fit_diff: 13.0 },
    { song_id: 2, isnew: false, fit_diff: 12.0 },
    { song_id: 3, isnew: true, fit_diff: 11.0 },
  ])
  const { best50, fitTotal, candidates } = fitBest50([rec(1), rec(2), rec(3)], { totalList: lib })
  assert.equal(candidates, 3)
  assert.deepEqual(best50.sd.map(x => x.song_id), [1, 2])
  assert.deepEqual(best50.dx.map(x => x.song_id), [3])
  assert.equal(fitTotal, fitRa(13) + fitRa(12) + fitRa(11))
  assert.equal(fitTotal, best50.sd_total + best50.dx_total)
})
