/**
 * 随心配变体计算单测（设计《b50扩展实现设计.md》§4 / §10）
 *
 * 全部离线：曲库经 deps 注入假对象，不碰 mai 单例、不触网、不落盘。
 * 判定式本身（寸/锁 边界、V3/V26/V30 的锁）在 variantSpec.test.js；此处测**管线**：
 * 过滤 → 分池 → 截断 → 合计，以及 V1/V2/V22/V23 的锁。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { variantBest50 } from '../lib/variantB50.js'
import { fitBest50 } from '../lib/fit.js'
import { rankBest50, DX_SLOTS, SD_SLOTS } from '../lib/b50Core.js'
import { computeRating } from '../lib/calc.js'
import { resolveAllCondition, resolveVariant, repeatSpec } from '../lib/variantSpec.js'

/** 假曲库（byId 形态，与 fit.test.js 同款） */
function mkLib(specs) {
  const map = new Map()
  for (const s of specs) {
    const difficulties = Array.from({ length: 5 }, (_, i) => ({
      level_index: i, level: s.level ?? '13', level_value: 13,
      note_designer: s.note_designer ?? '-',
      stats: s.fit_diff != null && i === 3 ? { fit_diff: s.fit_diff } : null,
    }))
    map.set(s.song_id, {
      song_id: s.song_id, song_name: s.song_name ?? `S${s.song_id}`,
      genre: s.genre ?? '舞萌', version_str: s.version_str ?? 'maimai',
      type: s.type ?? 'SD', isnew: s.isnew ?? false, difficulties,
    })
  }
  return { byId: id => map.get(id) ?? null }
}

/** 假曲库（root 形态，覆盖 makeIndex 的 Map 分支） */
function mkLibRoot(specs) {
  const lib = mkLib(specs)
  const root = specs.map(s => lib.byId(s.song_id))
  return { root, byId: id => root.find(s => s.song_id === id) ?? null }
}

const rec = (song_id, extra = {}) => ({
  song_id, level_index: 3, level: '13', level_value: 13, type: 'SD',
  song_name: `S${song_id}`, achievements: 100.5, rating: computeRating(13, 100.5),
  rate: 'sssp', fc: null, fs: null, dx_score: 1000, ...extra,
})

/** 造 N 首曲 + 对应成绩（rating 随 i 递减，便于断言排序） */
function mkRun(n, { isnew = false, base = 1000, rating = i => 1000 - i } = {}) {
  const specs = []
  const records = []
  for (let i = 0; i < n; i++) {
    const id = base + i
    specs.push({ song_id: id, isnew })
    records.push(rec(id, { rating: rating(i) }))
  }
  return { specs, records }
}

// ---------------------------------------------------------------- 基础管线

test('分池（isnew）+ 截断 + totals：与真实 B50 同规则', () => {
  const old = mkRun(40, { isnew: false, base: 1000, rating: i => 300 + i })
  const news = mkRun(20, { isnew: true, base: 2000, rating: i => 300 + i })
  const lib = mkLib([...old.specs, ...news.specs])
  const records = [...old.records, ...news.records]

  const spec = { key: 'all', label: '全部', mode: 'rank', match: () => true }
  const { best50, total, candidates } = variantBest50(records, spec, { totalList: lib })

  assert.equal(candidates, 60, 'candidates 计过滤后的谱面数，非截断后的条数')
  assert.equal(best50.sd.length, SD_SLOTS)
  assert.equal(best50.dx.length, DX_SLOTS)
  // 各池取 rating 最高的 N 条（rating 随 i 递增 ⇒ 取 id 最大的 N 条）
  assert.deepEqual(best50.sd.map(x => x.song_id), Array.from({ length: 35 }, (_, k) => 1000 + (39 - k)))
  assert.deepEqual(best50.dx.map(x => x.song_id), Array.from({ length: 15 }, (_, k) => 2000 + (19 - k)))
  assert.equal(total, best50.sd_total + best50.dx_total)
})

test('root 形态曲库与 byId 形态结果一致（makeIndex 的 Map 分支不改变语义）', () => {
  const run = mkRun(5, { isnew: true, base: 500 })
  const spec = resolveVariant('FC')
  const records = run.records.map(r => ({ ...r, fc: 'fc' }))
  const a = variantBest50(records, spec, { totalList: mkLib(run.specs) })
  const b = variantBest50(records, spec, { totalList: mkLibRoot(run.specs) })
  assert.deepEqual(a, b)
})

test('V22/V23 锁：宴谱与曲库未收录的成绩一律跳过', () => {
  const lib = mkLib([
    { song_id: 100001, isnew: true },      // 宴谱：曲库里有也排除
    { song_id: 3000, isnew: false },
  ])
  const records = [rec(100001, { fc: 'fc' }), rec(3000, { fc: 'fc' }), rec(9999, { fc: 'fc' })]
  const { candidates, best50 } = variantBest50(records, resolveVariant('FC'), { totalList: lib })
  assert.equal(candidates, 1, '只剩 3000')
  assert.deepEqual(best50.sd.map(x => x.song_id), [3000])
})

test('空结果与退化入参：candidates === 0，不抛错', () => {
  const lib = mkLib([{ song_id: 1 }])
  const cases = [
    [[], resolveVariant('FC'), { totalList: lib }],
    [[rec(1)], resolveVariant('FC'), { totalList: lib }],        // 无 fc
    [[rec(1, { fc: 'fc' })], resolveVariant('FC'), {}],           // 未注入曲库
    [[rec(1, { fc: 'fc' })], resolveVariant('FC'), undefined],
    [null, resolveVariant('FC'), { totalList: lib }],
    [[rec(1, { fc: 'fc' })], null, { totalList: lib }],           // 无规格
  ]
  for (const [records, spec, deps] of cases) {
    const { best50, total, candidates } = variantBest50(records, spec, deps)
    assert.equal(candidates, 0)
    assert.equal(total, 0)
    assert.deepEqual(best50, { sd_total: 0, dx_total: 0, sd: [], dx: [] })
  }
})

// ---------------------------------------------------------------- V2 / V1

test('V2 锁：全红b50 与 红谱50 结果逐字段相等', () => {
  const specs = []
  const records = []
  for (let i = 0; i < 60; i++) {
    const id = 1000 + i
    specs.push({ song_id: id, isnew: i % 3 === 0 })
    records.push(rec(id, { level_index: i % 5, rating: 200 + i }))
  }
  const lib = mkLib(specs)
  const a = variantBest50(records, resolveVariant('红'), { totalList: lib })
  const b = variantBest50(records, resolveAllCondition('红'), { totalList: lib })
  assert.deepEqual(a, b, '全红b50 ≡ 红谱50（含 candidates 与 totals）')
  assert.ok(a.candidates > 0)
})

test('V1 锁：歌50 重复填充 B35+B15，合计 = 50 × 该谱 Rating', () => {
  const lib = mkLib([{ song_id: 799 }])
  const rating = 305
  const records = [rec(799, { rating, achievements: 100.8 })]

  const { best50, total, candidates } = variantBest50(records, repeatSpec({ song_id: 799, level_index: 3 }, '茄子'), { totalList: lib })
  assert.equal(candidates, 1)
  assert.equal(best50.sd.length, SD_SLOTS)
  assert.equal(best50.dx.length, DX_SLOTS)
  assert.ok(best50.sd.every(x => x.song_id === 799 && x.rating === rating))
  assert.ok(best50.dx.every(x => x.song_id === 799 && x.rating === rating))
  assert.equal(best50.sd_total, rating * SD_SLOTS)
  assert.equal(best50.dx_total, rating * DX_SLOTS)
  assert.equal(total, rating * 50)

  // 没有该谱成绩 → candidates 0（调用方据此回「未找到该曲目的成绩」）
  const miss = variantBest50([rec(800)], repeatSpec({ song_id: 799, level_index: 3 }, '茄子'), { totalList: lib })
  assert.equal(miss.candidates, 0)
  assert.equal(miss.total, 0)

  // 同一谱面同难度出现多条（重复上传）→ 取 rating 最高的一条
  const dup = variantBest50([rec(799, { rating: 100 }), rec(799, { rating: 400 })],
    repeatSpec({ song_id: 799, level_index: 3 }, '茄子'), { totalList: lib })
  assert.equal(dup.best50.sd[0].rating, 400)
})

test('歌50 模拟模式：预置成绩直接填池，**完全不看传入的 records**', () => {
  const lib = mkLib([{ song_id: 799 }])
  const sim = rec(799, { rating: 407, achievements: 101, rate: 'sssp', fc: 'app', fs: 'fdxp', dx_score: 2100 })

  // 传空 records 也必须出图（旧路径会因 candidates 0 回「未找到该曲目的成绩」）
  const { best50, total, candidates } = variantBest50(
    [], repeatSpec({ song_id: 799, level_index: 3 }, '歌50 · 白潘 · 模拟 …', sim), { totalList: lib })
  assert.equal(candidates, 1)
  assert.equal(total, 407 * 50)
  assert.ok(best50.sd.every(x => x === sim || (x.rating === 407 && x.fc === 'app' && x.fs === 'fdxp' && x.dx_score === 2100)))

  // 有真实成绩在场也不会被选中（模拟成绩优先）
  const other = variantBest50([rec(799, { rating: 100 })],
    repeatSpec({ song_id: 799, level_index: 3 }, '歌50 · 白潘 · 模拟 …', sim), { totalList: lib })
  assert.equal(other.total, 407 * 50)
})

// ---------------------------------------------------------------- 变体接线

test('变体接线：FC/拼机/分类/版本 各挑出正确候选', () => {
  const lib = mkLib([
    { song_id: 1, isnew: false, genre: '舞萌', version_str: 'maimai' },
    { song_id: 2, isnew: false, genre: '东方Project', version_str: 'maimai FiNALE' },
    { song_id: 3, isnew: true, genre: '东方Project', version_str: 'maimai でらっくす PRiSM PLUS' },
  ])
  const records = [
    rec(1, { fc: 'fc', fs: 'fsd' }),
    rec(2, { fc: 'ap', fs: null }),
    rec(3, { fc: 'fcp', fs: 'sync' }),
  ]
  const ids = (spec, deps = { totalList: lib }) => {
    const { best50 } = variantBest50(records, spec, deps)
    return [...best50.sd, ...best50.dx].map(x => x.song_id)
  }
  assert.deepEqual(ids(resolveVariant('FC')).sort(), [1, 3], 'FC 含 fc 与 fcp，不含 ap')
  assert.deepEqual(ids(resolveVariant('FC+')), [3])
  assert.deepEqual(ids(resolveVariant('拼机')).sort(), [1, 3])
  assert.deepEqual(ids(resolveVariant('单刷')), [2])
  assert.deepEqual(ids(resolveVariant('东方')).sort(), [2, 3])
  assert.deepEqual(ids(resolveVariant('辉')), [2], '版本 FiNALE')
  assert.deepEqual(ids(resolveVariant('nb')), [], '无 ≥100.8 的成绩')
})

test('重构等价锁：不过滤任何东西时，变体管线 == 拟合管线的排名口径', () => {
  // 让拟合 rating 与真实 rating 相等（fit_diff = 真实定数），两条管线应产出完全相同的 B50
  const specs = []
  const records = []
  for (let i = 0; i < 50; i++) {
    const id = 1000 + i
    const ach = 99 + (i % 10) * 0.1
    specs.push({ song_id: id, isnew: i % 4 === 0, fit_diff: 13 })
    records.push(rec(id, { achievements: ach, rating: computeRating(13, ach) }))
  }
  const lib = mkLib(specs)
  const fit = fitBest50(records, { totalList: lib })
  const all = variantBest50(records, { key: 'all', mode: 'rank', match: () => true }, { totalList: lib })
  assert.deepEqual(all.best50, fit.best50)
  assert.equal(all.total, fit.fitTotal)
  assert.equal(all.candidates, fit.candidates)

  // 且与直接调 rankBest50 的结果一致（三处口径同源）
  const direct = rankBest50(records.map((r, i) => ({ isnew: i % 4 === 0, item: r })))
  assert.equal(direct.best50.sd_total, all.best50.sd_total)
  assert.equal(direct.best50.dx_total, all.best50.dx_total)
})

test('同分稳定性：rating 相同时保持入参顺序（与 fit 同款 Array.sort 语义）', () => {
  const specs = [{ song_id: 5000 }, { song_id: 5001 }, { song_id: 5002 }]
  const lib = mkLib(specs)
  const records = [rec(5002, { rating: 300 }), rec(5000, { rating: 300 }), rec(5001, { rating: 300 })]
  const { best50 } = variantBest50(records, { key: 'all', mode: 'rank', match: () => true }, { totalList: lib })
  assert.deepEqual(best50.sd.map(x => x.song_id), [5002, 5000, 5001])
})
