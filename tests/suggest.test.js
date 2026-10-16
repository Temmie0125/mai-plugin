/**
 * 推分建议单测（lib/suggest.js 纯算法 + views.js suggestView 版式冒烟）
 * 纯合成数据，不依赖曲库/网络/浏览器。
 *
 * 档位口径（SUGGEST_TIERS 进度分带，用户当前达成率 [min, max) 归档）：
 *   100.5:[100.0,100.5) 100.0:[99.5,100.0) 99.5:[99.0,99.5) 99.0:[98.5,99.0) 98.5:[0,98.5)
 * 定数区间（docs/推分建议.md 公式）：averageDs = Rating/(22.4×50)，候选 [averageDs, +0.5]
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

const {
  parseSuggestArgs, averageDsRange, buildSuggestList, SUGGEST_TIERS,
  suggestUsage, suggestArgError, suggestRatingError, RATING_MAX,
} = await import('../lib/suggest.js')
const { suggestView } = await import('../lib/render/views.js')

/** 曲库 stub：与 MusicList 同构（.root 迭代） */
const listOf = (songs) => ({ root: songs })
const diff = (li, ds, stats = {}) => ({ level_index: li, level: '13+', level_value: ds, stats })
const song = (id, diffs, type = 'dx') => ({ song_id: id, song_name: `曲${id}`, type, difficulties: diffs })
const rec = (songId, li, achievements) => ({ song_id: songId, level_index: li, achievements })
const tierRows = (out, tier) => out.tiers.find(t => t.tier === tier).rows

// ---------------------------------------------------------------- 参数解析

test('参数解析：无参 → 默认平均达成率', () => {
  assert.deepEqual(parseSuggestArgs(''), { mode: 'avg' })
  assert.deepEqual(parseSuggestArgs(undefined), { mode: 'avg' })
  assert.deepEqual(parseSuggestArgs('   '), { mode: 'avg' })
})

test('参数解析：模式词（中英文、大小写、顺序任意、后者生效）', () => {
  assert.deepEqual(parseSuggestArgs('定数'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('差值'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('定数差值'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('DIFF'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('ds'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('平均'), { mode: 'avg' })
  assert.deepEqual(parseSuggestArgs('AVG'), { mode: 'avg' })
  assert.deepEqual(parseSuggestArgs('平均 定数'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('15000 定数'), { mode: 'diff', rating: 15000 })
  assert.deepEqual(parseSuggestArgs('定数 15000'), { mode: 'diff', rating: 15000 })
})

test('参数解析：目标 Rating 整数合法，越界报 rating', () => {
  assert.deepEqual(parseSuggestArgs('15000'), { mode: 'avg', rating: 15000 })
  assert.deepEqual(parseSuggestArgs(String(RATING_MAX)), { mode: 'avg', rating: RATING_MAX })
  assert.equal(parseSuggestArgs('0').error, 'rating')
  assert.equal(parseSuggestArgs(String(RATING_MAX + 1)).error, 'rating')
})

test('参数解析：小数/负数 → rating 错误并指认 token；乱参 → arg 错误', () => {
  assert.deepEqual(parseSuggestArgs('15000.5'), { error: 'rating', token: '15000.5' })
  assert.deepEqual(parseSuggestArgs('-500'), { error: 'rating', token: '-500' })
  assert.deepEqual(parseSuggestArgs('abc'), { error: 'arg', token: 'abc' })
  assert.deepEqual(parseSuggestArgs('定数 abc'), { error: 'arg', token: 'abc' })
})

test('错误文案：usage 含命令头与两种模式说明', () => {
  const usage = suggestUsage('mai')
  assert.match(usage, /#mai suggest/)
  assert.match(usage, /平均/)
  assert.match(usage, /定数/)
  assert.match(suggestArgError('abc', 'mai'), /abc/)
  assert.match(suggestRatingError('-500'), /-500/)
})

// ---------------------------------------------------------------- 定数区间

test('定数区间：文档公式（14500 → 12.9~13.4）', () => {
  assert.deepEqual(averageDsRange(14500), { min: 12.9, max: 13.4 })
  assert.deepEqual(averageDsRange(11200), { min: 10, max: 10.5 })
})

test('定数区间：两端收敛防倒挂（低分端 max<min 收敛；顶级端 min>15 收敛）', () => {
  assert.deepEqual(averageDsRange(100), { min: 1, max: 1 })
  assert.deepEqual(averageDsRange(RATING_MAX), { min: 15, max: 15 })
})

// ---------------------------------------------------------------- 分带与排序

test('分带：当前达成率归档，未玩入底档，已鸟加(≥100.5)全档排除', () => {
  const songs = [
    song(1, [diff(3, 13.2, { avg: 99.0 })]),   // ach 100.2 → 100.5 档
    song(2, [diff(3, 13.3, { avg: 98.5 })]),   // ach 99.8  → 100.0 档
    song(3, [diff(3, 13.4, { avg: 97.0 })]),   // ach 99.1  → 99.5 档
    song(4, [diff(3, 13.1, { avg: 96.0 })]),   // ach 98.7  → 99.0 档
    song(5, [diff(3, 13.0, { avg: 95.0 })]),   // 未玩      → 98.5 档
    song(6, [diff(3, 13.5, { avg: 99.9 })]),   // ach 100.5 → 排除
  ]
  const records = [rec(1, 3, 100.2), rec(2, 3, 99.8), rec(3, 3, 99.1), rec(4, 3, 98.7), rec(6, 3, 100.5)]
  const out = buildSuggestList({ totalList: listOf(songs), records, mode: 'avg', dsRange: { min: 13.0, max: 13.5 } })
  assert.deepEqual(tierRows(out, 100.5).map(r => r.song_id), [1])
  assert.deepEqual(tierRows(out, 100.0).map(r => r.song_id), [2])
  assert.deepEqual(tierRows(out, 99.5).map(r => r.song_id), [3])
  assert.deepEqual(tierRows(out, 99.0).map(r => r.song_id), [4])
  assert.deepEqual(tierRows(out, 98.5).map(r => r.song_id), [5])
})

test('分带边界：100.0 含于顶档 [100.0,100.5)；99.999 归 100.0 档', () => {
  const songs = [song(1, [diff(3, 13.2, { avg: 99.0 })]), song(2, [diff(3, 13.3, { avg: 98.0 })])]
  const out = buildSuggestList({
    totalList: listOf(songs), records: [rec(1, 3, 100.0), rec(2, 3, 99.999)],
    mode: 'avg', dsRange: { min: 13.0, max: 13.5 },
  })
  assert.deepEqual(tierRows(out, 100.5).map(r => r.song_id), [1])
  assert.deepEqual(tierRows(out, 100.0).map(r => r.song_id), [2])
})

test('排序与截断：avg 降序取前 5；平分时定数高者优先、再 id 升序', () => {
  const songs = []
  for (let i = 1; i <= 7; i++) songs.push(song(i, [diff(3, 13.0 + i * 0.01, { avg: 100 - i })]))
  // 与 7 号同 avg=93 的平分曲：定数更高（13.3 > 13.07），应排在 7 号前
  songs.push(song(8, [diff(3, 13.3, { avg: 93 })]))
  const out = buildSuggestList({
    totalList: listOf(songs), records: [], mode: 'avg', dsRange: { min: 13.0, max: 13.5 },
  })
  const rows = tierRows(out, 98.5)
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map(r => r.score), [99, 98, 97, 96, 95])   // avg 降序
  const tie = buildSuggestList({
    totalList: listOf([song(7, [diff(3, 13.07, { avg: 93 })]), song(8, [diff(3, 13.3, { avg: 93 })])]),
    records: [], mode: 'avg', dsRange: { min: 13.0, max: 13.5 },
  })
  assert.deepEqual(tierRows(tie, 98.5).map(r => r.song_id), [8, 7]) // 同分定数高者优先
})

test('模式 diff：按 官方定数−拟合定数 降序；缺 fit_diff/avg 的谱面按各自模式排除', () => {
  const songs = [
    song(1, [diff(3, 13.5, { fit_diff: 13.0, avg: 50 })]),   // 差 +0.5
    song(2, [diff(3, 13.4, { fit_diff: 13.2, avg: 99 })]),   // 差 +0.2
    song(3, [diff(3, 13.3, { fit_diff: 0, avg: 98 })]),      // fit_diff 无效 → diff 模式排除
    song(4, [diff(3, 13.2, { fit_diff: 13.4 })]),            // avg 无效 → avg 模式排除
  ]
  const dsRange = { min: 13.0, max: 13.5 }
  const byDiff = buildSuggestList({ totalList: listOf(songs), records: [], mode: 'diff', dsRange })
  // 4 号 fit_diff 有效（差 −0.2）也是 diff 模式合法候选，按差值降序排在最后
  assert.deepEqual(tierRows(byDiff, 98.5).map(r => r.song_id), [1, 2, 4])
  const byAvg = buildSuggestList({ totalList: listOf(songs), records: [], mode: 'avg', dsRange })
  // 3 号 avg=98 有效照常参与（缺 fit_diff 不影响 avg 模式）；4 号无 avg → 排除
  assert.deepEqual(tierRows(byAvg, 98.5).map(r => r.song_id), [2, 3, 1])
})

test('候选池：宴谱与区间外定数排除；未玩展示 achievements=null', () => {
  const songs = [
    song(100000, [diff(3, 13.2, { avg: 99 })]),              // 宴谱
    song(1, [diff(3, 12.9, { avg: 99 })]),                   // 低于区间
    song(2, [diff(3, 13.6, { avg: 99 })]),                   // 高于区间
    song(3, [diff(3, 13.2, { avg: 99 })]),
  ]
  const out = buildSuggestList({ totalList: listOf(songs), records: [], mode: 'avg', dsRange: { min: 13.0, max: 13.5 } })
  const rows = tierRows(out, 98.5)
  assert.deepEqual(rows.map(r => r.song_id), [3])
  assert.equal(rows[0].achievements, null)
})

test('每档档位表为默认五档 SUGGEST_TIERS，空档 rows 为空数组', () => {
  const out = buildSuggestList({ totalList: listOf([]), records: [], mode: 'avg', dsRange: { min: 13.0, max: 13.5 } })
  assert.deepEqual(out.tiers.map(t => t.tier), SUGGEST_TIERS.map(t => t.tier))
  assert.ok(out.tiers.every(t => t.rows.length === 0))
})

// ---------------------------------------------------------------- 版式冒烟

test('suggestView：块头/行/空档文案与整体尺寸', () => {
  const songs = [
    song(1, [diff(3, 13.2, { avg: 99.0 })]),
    song(5, [diff(3, 13.0, { avg: 95.0 })]),
  ]
  const built = buildSuggestList({
    totalList: listOf(songs), records: [rec(1, 3, 100.2)], mode: 'avg', dsRange: { min: 13.0, max: 13.5 },
  })
  const view = suggestView({
    tiers: built.tiers, mode: 'avg', dsRange: built.dsRange,
    currentRating: 14500, targetRating: 15000, serviceName: '水鱼', botName: 'TestBot',
  })
  assert.equal(view.width, 1000)
  assert.ok(Number.isInteger(view.height) && view.height >= 1000)
  assert.equal(view.bgCss.includes('linear-gradient'), true)

  const all = view.texts.map(t => t.text).join('\n')
  for (const tier of [100.5, 100, 99.5, 99, 98.5]) {
    assert.match(all, new RegExp(`目标 ${tier.toFixed(1)}%`))
  }
  assert.match(all, /平均达成率推荐 · 定数区间 13\.0~13\.5 · Rating 14500 → 15000/)
  assert.match(all, /100\.2000%/)     // 已玩成绩 4 位小数
  assert.match(all, /未玩/)
  assert.match(all, /玩家均 99\.00%/)
  assert.match(all, /暂无符合条件的谱面/)  // 空档提示
  // 曲绘 + 类型图标按行注入（2 行谱面 → 2 组），z=2 压过毛玻璃卡
  const covers = view.images.filter(im => String(im.src).includes('/cover/'))
  assert.equal(covers.length, 2)
  assert.ok(covers.every(im => im.z === 2))
})

test('suggestView：定数差值模式的推荐度列展示 ±号', () => {
  const songs = [song(1, [diff(3, 13.5, { fit_diff: 13.0 })])]
  const built = buildSuggestList({ totalList: listOf(songs), records: [], mode: 'diff', dsRange: { min: 13.0, max: 13.5 } })
  const view = suggestView({
    tiers: built.tiers, mode: 'diff', dsRange: built.dsRange,
    currentRating: 14500, targetRating: 14500, serviceName: '水鱼', botName: 'TestBot',
  })
  const all = view.texts.map(t => t.text).join('\n')
  assert.match(all, /定数差值推荐/)
  assert.match(all, /定数差 \+0\.50/)
  assert.match(all, /当前 100\.00~100\.49/)   // 半开区间展示口径
  assert.match(all, /Rating 14500/)    // 目标=当前 → 不出现箭头
})
