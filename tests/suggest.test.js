/**
 * 推分建议单测（lib/suggest.js 纯算法 + views.js suggestView 版式冒烟）
 * 纯合成数据，不依赖曲库/网络/浏览器。
 *
 * 口径（threshold 13000 → baseDs 11.6，窗口宽 0.3、步进 0.3、首档自 baseDs−0.3 起，
 * 半开区间 [lo, hi)）：
 *   100.5:[11.3,11.6) 100.0:[11.6,11.9) 99.5:[11.9,12.2) 99.0:[12.2,12.5) 98.5:[12.5,12.8)
 * 五档窗口互不重叠 ⇒ 每张谱面按定数至多落入一档，各档推荐互不重复。
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
  parseSuggestArgs, defaultRatingThreshold, thresholdBaseDs, buildSuggestList,
  SUGGEST_TIERS, suggestUsage, suggestArgError, suggestRatingError, RATING_MAX,
} = await import('../lib/suggest.js')
const { suggestView } = await import('../lib/render/views.js')

/** 曲库 stub：与 MusicList 同构（.root 迭代） */
const listOf = (songs) => ({ root: songs })
const diff = (li, ds, stats = {}) => ({ level_index: li, level: '13+', level_value: ds, stats })
const song = (id, diffs, { isnew = false, type = 'dx' } = {}) =>
  ({ song_id: id, song_name: `曲${id}`, type, isnew, difficulties: diffs })
const rec = (songId, li, achievements) => ({ song_id: songId, level_index: li, achievements })
const tierRows = (out, tier) => out.tiers.find(t => t.tier === tier).rows
const tierWindow = (out, tier) => {
  const t = out.tiers.find(t => t.tier === tier)
  return [t.lo / 10, t.hi / 10]
}

// ---------------------------------------------------------------- 参数解析

test('参数解析：无参 → 默认定数差值', () => {
  assert.deepEqual(parseSuggestArgs(''), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs(undefined), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('   '), { mode: 'diff' })
})

test('参数解析：模式词（中英文、大小写、顺序任意、后者生效）', () => {
  assert.deepEqual(parseSuggestArgs('平均'), { mode: 'avg' })
  assert.deepEqual(parseSuggestArgs('AVG'), { mode: 'avg' })
  assert.deepEqual(parseSuggestArgs('定数'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('差值'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('定数差值'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('DIFF'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('ds'), { mode: 'diff' })
  assert.deepEqual(parseSuggestArgs('定数 平均'), { mode: 'avg' })
  assert.deepEqual(parseSuggestArgs('15000 平均'), { mode: 'avg', rating: 15000 })
  assert.deepEqual(parseSuggestArgs('平均 15000'), { mode: 'avg', rating: 15000 })
})

test('参数解析：阈值 Rating 整数合法，越界报 rating', () => {
  assert.deepEqual(parseSuggestArgs('15000'), { mode: 'diff', rating: 15000 })
  assert.deepEqual(parseSuggestArgs(String(RATING_MAX)), { mode: 'diff', rating: RATING_MAX })
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
  assert.match(usage, /500 档/)
  assert.match(suggestArgError('abc', 'mai'), /abc/)
  assert.match(suggestRatingError('-500'), /-500/)
})

// ---------------------------------------------------------------- 阈值与窗口

test('默认阈值：向上取整到下一个 500 档（12500 → 13000、12345 → 12500）', () => {
  assert.equal(defaultRatingThreshold(12500), 13000)
  assert.equal(defaultRatingThreshold(12345), 12500)
  assert.equal(defaultRatingThreshold(13000), 13500)
  assert.equal(defaultRatingThreshold(499), 500)
  assert.equal(defaultRatingThreshold(0), 500)
})

test('阈值 → 平均定数（文档公式，夹在 1~15）', () => {
  assert.equal(thresholdBaseDs(13000), 11.6)
  assert.equal(thresholdBaseDs(11200), 10)
  assert.equal(thresholdBaseDs(500), 1)
  assert.equal(thresholdBaseDs(16800), 15)
})

test('窗口：宽 0.3、步进 0.3、互不重叠（baseDs 11.6 → 最低档 12.5~12.7）', () => {
  const out = buildSuggestList({ totalList: listOf([]), records: [], mode: 'diff', thresholdRating: 13000 })
  assert.deepEqual(out.tiers.map(t => t.tier), [...SUGGEST_TIERS])
  assert.deepEqual(tierWindow(out, 100.5), [11.3, 11.6])
  assert.deepEqual(tierWindow(out, 100.0), [11.6, 11.9])
  assert.deepEqual(tierWindow(out, 99.5), [11.9, 12.2])
  assert.deepEqual(tierWindow(out, 99.0), [12.2, 12.5])
  assert.deepEqual(tierWindow(out, 98.5), [12.5, 12.8])
})

// ---------------------------------------------------------------- 分带与排序

test('窗口归属：谱面按定数落入唯一一档，各档推荐互不重复', () => {
  const songs = [
    song(1, [diff(3, 11.3, { fit_diff: 11.2 })]),   // 113 → 100.5 档
    song(2, [diff(3, 11.5, { fit_diff: 11.3 })]),   // 115 → 100.5 档
    song(3, [diff(3, 11.6, { fit_diff: 11.5 })]),   // 116 → 100.0 档（下边界含）
    song(4, [diff(3, 11.9, { fit_diff: 11.7 })]),   // 119 → 99.5 档
    song(5, [diff(3, 12.4, { fit_diff: 12.2 })]),   // 124 → 99.0 档
    song(6, [diff(3, 12.5, { fit_diff: 12.3 })]),   // 125 → 98.5 档（下边界含）
    song(7, [diff(3, 11.2, { fit_diff: 11.0 })]),   // 112：低于全部窗口
    song(8, [diff(3, 12.8, { fit_diff: 12.6 })]),   // 128：高于全部窗口（上边界不含）
  ]
  const out = buildSuggestList({ totalList: listOf(songs), records: [], mode: 'diff', thresholdRating: 13000 })
  assert.deepEqual(tierRows(out, 100.5).map(r => r.song_id), [2, 1])   // 档内按定数差降序：+0.2 > +0.1
  assert.deepEqual(tierRows(out, 100.0).map(r => r.song_id), [3])
  assert.deepEqual(tierRows(out, 99.5).map(r => r.song_id), [4])
  assert.deepEqual(tierRows(out, 99.0).map(r => r.song_id), [5])
  assert.deepEqual(tierRows(out, 98.5).map(r => r.song_id), [6])
})

test('进度闸：已达目标档（含已鸟加）不再进该档；未玩按 0 全档可进', () => {
  const songs = [
    song(1, [diff(3, 11.9, { fit_diff: 11.7 })]),
    song(2, [diff(3, 11.9, { fit_diff: 11.7 })]),
    song(3, [diff(3, 11.9, { fit_diff: 11.7 })]),
  ]
  const records = [rec(1, 3, 100.5), rec(2, 3, 100.2)]
  const out = buildSuggestList({ totalList: listOf(songs), records, mode: 'diff', thresholdRating: 13000 })
  // 三张都在 99.5 档窗口：谱1 已鸟加排除；谱2 100.2 ≥ 99.5 排除；谱3 未玩进档
  assert.deepEqual(tierRows(out, 99.5).map(r => r.song_id), [3])
  assert.ok(tierRows(out, 100.5).length === 0 && tierRows(out, 98.5).length === 0)
})

test('新歌与宴谱排除；无统计（fit_diff/avg 非正数）按各自模式排除', () => {
  const songs = [
    song(1, [diff(3, 11.9, { fit_diff: 11.7, avg: 98 })]),
    song(2, [diff(3, 11.9, { fit_diff: 11.7, avg: 98 })], { isnew: true }),
    song(3, [diff(3, 11.9, { fit_diff: 0, avg: 97 })]),      // fit_diff 无效 → diff 模式排除
    song(4, [diff(3, 11.9, { fit_diff: 11.9 })]),            // avg 无效 → avg 模式排除
    song(100000, [diff(3, 11.9, { fit_diff: 11.7, avg: 98 })]), // 宴谱
  ]
  const byDiff = buildSuggestList({ totalList: listOf(songs), records: [], mode: 'diff', thresholdRating: 13000 })
  assert.deepEqual(tierRows(byDiff, 99.5).map(r => r.song_id), [1, 4])   // 4 号 fit_diff 有效照常参与
  const byAvg = buildSuggestList({ totalList: listOf(songs), records: [], mode: 'avg', thresholdRating: 13000 })
  assert.deepEqual(tierRows(byAvg, 99.5).map(r => r.song_id), [1, 3])
})

test('排序与截断：推荐度降序取前 5；平分时定数高者优先、再 id 升序', () => {
  const songs = []
  for (let i = 1; i <= 7; i++) songs.push(song(i, [diff(3, 11.4, { fit_diff: 10.9 + i * 0.01 })]))
  const out = buildSuggestList({ totalList: listOf(songs), records: [], mode: 'diff', thresholdRating: 13000 })
  const rows = tierRows(out, 100.5)
  assert.equal(rows.length, 5)
  // 7 张都在首档窗口内（ds 11.4），按定数差降序（0.49~0.43）截取前 5
  assert.deepEqual(rows.map(r => r.score.toFixed(2)), ['0.49', '0.48', '0.47', '0.46', '0.45'])
  // 平分夹具：fit_diff = 定数 ⇒ score 恰为 0.0（浮点精确相等），验证定数高者优先
  const tie = buildSuggestList({
    totalList: listOf([song(7, [diff(3, 11.4, { fit_diff: 11.4 })]), song(8, [diff(3, 11.5, { fit_diff: 11.5 })])]),
    records: [], mode: 'diff', thresholdRating: 13000,
  })
  assert.deepEqual(tierRows(tie, 100.5).map(r => r.song_id), [8, 7])   // 同分定数高者优先
})

test('avg 模式：按 stats.avg 降序', () => {
  const songs = [
    song(1, [diff(3, 11.9, { fit_diff: 11.7, avg: 97.5 })]),
    song(2, [diff(3, 12.0, { fit_diff: 11.7, avg: 99.1 })]),
    song(3, [diff(3, 12.1, { fit_diff: 11.7, avg: 98.3 })]),
  ]
  const out = buildSuggestList({ totalList: listOf(songs), records: [], mode: 'avg', thresholdRating: 13000 })
  assert.deepEqual(tierRows(out, 99.5).map(r => r.song_id), [2, 3, 1])   // 三张都在 99.5 档窗口内
})

test('空曲库 → 五档空 rows', () => {
  const out = buildSuggestList({ totalList: listOf([]), records: [], mode: 'diff', thresholdRating: 13000 })
  assert.ok(out.tiers.every(t => t.rows.length === 0))
})

// ---------------------------------------------------------------- 版式冒烟

test('suggestView：块头窗口/行/空档文案与整体尺寸', () => {
  const songs = [
    song(1, [diff(3, 12.1, { fit_diff: 11.7 })]),
    song(2, [diff(3, 11.9, { fit_diff: 11.7 })]),
  ]
  const built = buildSuggestList({ totalList: listOf(songs), records: [rec(1, 3, 99.0)], mode: 'diff', thresholdRating: 13000 })
  const view = suggestView({
    tiers: built.tiers, mode: 'diff', currentRating: 12500, thresholdRating: 13000,
    serviceName: '水鱼', botName: 'TestBot',
  })
  assert.equal(view.width, 1000)
  assert.ok(Number.isInteger(view.height) && view.height >= 1000)
  assert.equal(view.bgCss.includes('linear-gradient'), true)

  const all = view.texts.map(t => t.text).join('\n')
  for (const tier of [100.5, 100, 99.5, 99, 98.5]) {
    assert.match(all, new RegExp(`目标 ${tier.toFixed(1)}%`))
  }
  assert.match(all, /定数差值推荐 · Rating 12500 → 阈值 13000/)
  assert.match(all, /定数 11\.3~11\.5/)     // 100.5 档窗口
  assert.match(all, /定数 12\.5~12\.7/)     // 98.5 档窗口（用户口径）
  assert.match(all, /99\.0000%/)            // 已玩成绩 4 位小数
  assert.match(all, /未玩/)
  assert.match(all, /定数差 \+0\.40/)
  assert.match(all, /暂无符合条件的谱面/)   // 空档提示（fixture 只覆盖部分窗口）
  // 曲绘三态：本地命中 → file://…/cover/…；缺失 → 落雪 …/jacket/…（本地 0.png 挪到 fallback 兜底）
  const isCover = im => /\/(cover|jacket)\//.test(String(im.src)) || /\/cover\//.test(String(im.fallback ?? ''))
  const covers = view.images.filter(isCover)
  assert.ok(covers.length >= 2)
  assert.ok(covers.every(im => im.z === 2))
})

test('suggestView：平均达成率模式展示玩家均值', () => {
  const songs = [song(1, [diff(3, 12.5, { fit_diff: 12.0, avg: 99.21 })])]
  const built = buildSuggestList({ totalList: listOf(songs), records: [], mode: 'avg', thresholdRating: 13000 })
  const view = suggestView({
    tiers: built.tiers, mode: 'avg', currentRating: 12500, thresholdRating: 13000,
    serviceName: '水鱼', botName: 'TestBot',
  })
  const all = view.texts.map(t => t.text).join('\n')
  assert.match(all, /平均达成率推荐/)
  assert.match(all, /玩家均 99\.21%/)
})
