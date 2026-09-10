/**
 * 表格族纯几何层单测（lib/tableLayout.js）
 *
 * 分两类：
 *  1) 合成数据锁坐标 —— 抓 +30 / 行距 / 卡片框一类的差一错（一个常量写错就整页位移）
 *  2) 真实曲库锁高度与分组 —— 数值来自源 update_table.py 公式实算，且已与源**预生成 PNG**
 *     实际高度/标签位置交叉验证（见各用例注释）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RATING_GRID, PLATE_GRID, SEPARATOR,
  levelBuckets, bucketOf, splitWuBuckets, sortPlateSongs,
  displayRowCount, plateProgressLayout,
  ratingTableLayout, level15Layout, plateTableLayout,
} from '../lib/tableLayout.js'
import { LEVEL_LIST } from '../lib/constants.js'

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

const song = (id, lv = 13, lvValue = 13.0) => ({ song_id: id, difficulties: { level: lv, level_value: lvValue } })

// =====================================================================
// 一、合成数据：坐标锁值
// =====================================================================

test('常量与源一致（rating_table.py:32 / plate_table.py:55）', () => {
  assert.deepEqual(RATING_GRID, {
    startX: 140, startY: 450, gap: 85, rowCount: 14,
    statsFirstLineX: 534, statsFirstLineY: 238,
    statsSecondLineX: 292, statsSecondLineY: 323,
  })
  assert.deepEqual(PLATE_GRID, { startX: 180, startY: 490, gap: 96, rowCount: 12 })
  assert.equal(SEPARATOR.rating, 360)
  assert.equal(SEPARATOR.plate, 400)
})

test('定数表布局：16 首（跨 2 行）锁定坐标与高度', () => {
  const songs = Array.from({ length: 16 }, (_, i) => song(1000 + i))
  const lay = ratingTableLayout({ '13.7': songs })

  // rows = (16-1)//14 + 1 = 2 → current_y = 450 + 2*85 + 30 = 650 → height = 650 + 230
  assert.equal(lay.height, 880)
  assert.equal(lay.separatorHeight, 360)
  assert.equal(lay.groups.length, 1)
  const g = lay.groups[0]
  assert.equal(g.ds, '13.7')
  assert.equal(g.labelX, 70)
  assert.equal(g.labelY, 485) // 源 fot.draw(70, START_Y + 35, 40, ...)
  assert.equal(g.songs.length, 16)
  // 第 0 格 / 第 14 格（换行）
  assert.deepEqual([g.songs[0].x, g.songs[0].y], [140, 450])
  assert.deepEqual([g.songs[13].x, g.songs[13].y], [140 + 13 * 85, 450])
  assert.deepEqual([g.songs[14].x, g.songs[14].y], [140, 450 + 85])
  // 卡片框：源 generate_frosted_card(im, (50, 404, 1350, current_y))，PIL box 右下开区间
  assert.deepEqual(lay.card, { x: 50, y: 404, w: 1300, h: 650 - 404 })
  assert.deepEqual(lay.footer, { x: 700, y: 880 - 75 })
})

test('定数表布局：空组被跳过，多组按传入键序累加', () => {
  const lay = ratingTableLayout({ '13.7': [], '13.6': [song(1)], '13.5': [song(2), song(3)] })
  assert.equal(lay.groups.length, 2)
  // 13.6 一组 1 首：current_y 450 → 450 + 1*85 + 30 = 565
  assert.equal(lay.groups[0].ds, '13.6')
  assert.equal(lay.groups[1].ds, '13.5')
  assert.equal(lay.groups[1].labelY, 565 + 35)
})

test('lv15 布局：2 首 → 1 行 3 格，第 3 格为占位', () => {
  const lay = level15Layout([song(1, '15', 15.0), song(2, '15', 15.0)])
  assert.equal(lay.height, 650 + 450)
  assert.equal(lay.cells.length, 3)
  assert.equal(lay.cells[0].song.song_id, 1)
  assert.equal(lay.cells[1].song.song_id, 2)
  assert.equal(lay.cells[2].song, null) // 源 placeholders：song_chart(0) + ???? + UNKNOWN
  assert.deepEqual([lay.cells[0].x, lay.cells[0].y], [100, 500])
  assert.deepEqual([lay.cells[1].x, lay.cells[1].y], [525, 500])
  assert.deepEqual([lay.cells[2].x, lay.cells[2].y], [950, 500])
})

test('lv15 布局：0 首不产生格子（源 lines=0）', () => {
  const lay = level15Layout([])
  assert.equal(lay.height, 650)
  assert.equal(lay.cells.length, 0)
})

test('完成表布局：13 首（跨 2 行）锁定坐标与高度', () => {
  const buckets = levelBuckets(LEVEL_LIST)
  bucketOf(buckets, '13').songs.push(...Array.from({ length: 13 }, (_, i) => song(i)))
  const lay = plateTableLayout(buckets)

  // rows = (13-1)//12 + 1 = 2 → current_y = 490 + 2*96 + 30 = 712 → height = 712 + 180
  assert.equal(lay.height, 892)
  assert.equal(lay.separatorHeight, 400)
  assert.equal(lay.groups.length, 1)
  const g = lay.groups[0]
  assert.equal(g.level, '13')
  assert.equal(g.labelX, 72)
  assert.equal(g.labelY, 490 + 40)
  assert.deepEqual([g.songs[0].x, g.songs[0].y], [180, 490])
  assert.deepEqual([g.songs[11].x, g.songs[11].y], [180 + 11 * 96, 490])
  assert.deepEqual([g.songs[12].x, g.songs[12].y], [180, 490 + 96])
  assert.deepEqual(lay.card, { x: 50, y: 444, w: 1300, h: 712 - 444 })
  assert.equal(lay.pagesText, null)
})

test('完成表布局：pages 非 null 时输出 Pages n/2（舞/霸者）', () => {
  const buckets = levelBuckets(LEVEL_LIST)
  bucketOf(buckets, '13').songs.push(song(1))
  const lay = plateTableLayout(buckets, { pages: 1 })
  assert.equal(lay.pagesText.text, 'Pages 2/2')
  assert.equal(lay.pagesText.y, lay.height - 140)
})

// =====================================================================
// 二、等级分桶顺序 —— 本次移植的**头号陷阱**
// =====================================================================

test('levelBuckets：顺序为 reversed(LEVEL_LIST)，含 + 等级', () => {
  const buckets = levelBuckets(LEVEL_LIST)
  assert.deepEqual(buckets.map(b => b.level), [...LEVEL_LIST].reverse())
  assert.equal(buckets[0].level, '15')
  assert.equal(buckets[1].level, '14+')
  assert.equal(buckets[2].level, '14')
  assert.equal(buckets[3].level, '13+')
  assert.equal(buckets[4].level, '13')
  assert.equal(buckets.at(-1).level, '1')
})

test('回归：普通对象承载等级会把整数键提前，数组分桶不受影响', () => {
  // 这正是 bug 本尊：Python dict 保插入序，而 JS 对象把 "1".."15" 按升序提前到 "14+" 之前
  const asObject = {}
  for (let i = LEVEL_LIST.length - 1; i >= 0; i--) asObject[LEVEL_LIST[i]] = []
  assert.notDeepEqual(Object.keys(asObject), [...LEVEL_LIST].reverse(), 'JS 对象键序确实会被重排')
  assert.deepEqual(levelBuckets(LEVEL_LIST).map(b => b.level), [...LEVEL_LIST].reverse(), '数组分桶不受影响')
})

test('splitWuBuckets：以 13 为界，13 以上为第 1 页', () => {
  const buckets = levelBuckets(LEVEL_LIST)
  const [plus, low] = splitWuBuckets(buckets)
  assert.deepEqual(plus.map(b => b.level), ['15', '14+', '14', '13+'])
  assert.equal(low[0].level, '13')
  assert.equal(low.at(-1).level, '1')
  // 全体等级不重不漏
  assert.deepEqual([...plus, ...low].map(b => b.level), [...LEVEL_LIST].reverse())
})

test('splitWuBuckets：缺 13 时抛错（源 keys.index 的 ValueError 语义）', () => {
  assert.throws(() => splitWuBuckets(levelBuckets(['1', '2'])), /level '13' not found/)
})

test('sortPlateSongs：舞ReMASTER 用 difficulties[4]，其余用 [3]', () => {
  const a = { song_id: 1, difficulties: [{ level_value: 1 }, { level_value: 1 }, { level_value: 1 }, { level_value: 13.0 }, { level_value: 14.5 }] }
  const b = { song_id: 2, difficulties: [{ level_value: 1 }, { level_value: 1 }, { level_value: 1 }, { level_value: 14.0 }, { level_value: 15.0 }] }
  // b 在白谱集里 → 取 [4]=15.0；a 不在 → 取 [3]=13.0 → b 在前
  const sorted = sortPlateSongs([a, b], { remasterIdSet: new Set([2]) })
  assert.deepEqual(sorted.map(s => s.song_id), [2, 1])
  // 都非白谱 → a(13.0) vs b(14.0) → b 在前
  const sorted2 = sortPlateSongs([a, b], { remasterIdSet: new Set() })
  assert.deepEqual(sorted2.map(s => s.song_id), [2, 1])
})

test('sortPlateSongs：白谱 id 但无第 5 难度时回退 [3]（源 len(difficulties)>4 守卫）', () => {
  const a = { song_id: 1, difficulties: [{ level_value: 1 }, { level_value: 1 }, { level_value: 1 }, { level_value: 14.9 }] }
  const b = { song_id: 2, difficulties: [{ level_value: 1 }, { level_value: 1 }, { level_value: 1 }, { level_value: 13.0 }] }
  const sorted = sortPlateSongs([a, b], { remasterIdSet: new Set([1]) })
  assert.deepEqual(sorted.map(s => s.song_id), [1, 2])
})

// =====================================================================
// 三、真实曲库：高度与分组锁值（跳过于无曲库环境）
// =====================================================================

// ⚠️ service.js 在**模块顶层**执行 `const logger = global.logger || console`，
// 而 ESM 静态导入先于本文件的打桩语句求值 —— 必须像 rules.test.js / render-pages.mjs 那样
// 在测试体内**动态 import**，否则 logger 落到 console、`logger.mark` 不存在、init 直接抛。
let mai = null
let ready = false
test('载入曲库（离线）', async () => {
  ({ mai } = await import('../lib/service.js'))
  if (!mai.ready) await mai.init({ network: false }).catch(() => false)
  ready = mai.ready
})

test('真实定数表高度锁定', (t) => {
  if (!ready) return t.skip('曲库未就绪')
  const lv = (l) => mai.totalLevelData[l]
  assert.equal(ratingTableLayout(lv('13')).height, 4005)
  assert.equal(ratingTableLayout(lv('14+')).height, 1395)
  assert.equal(level15Layout(lv('15')['15.0']).height, 1100)
  assert.equal(lv('15')['15.0'].length, 2)
})

test('真实完成表高度锁定（已与源预生成 PNG 交叉验证）', (t) => {
  if (!ready) return t.skip('曲库未就绪')
  const buckets = levelBuckets(LEVEL_LIST)
  for (const id of mai.totalPlateIdList['真']) {
    const s = mai.totalList.byId(id)
    if (s) bucketOf(buckets, s.difficulties[3].level).songs.push(s)
  }
  // 源侧同数据生成的 plate_table/真.png 实测高度 1966，逐值一致
  assert.equal(plateTableLayout(buckets).height, 1966)
})

test('真实舞拆分高度锁定（已与源预生成 舞-1/舞-2 交叉验证）', (t) => {
  if (!ready) return t.skip('曲库未就绪')
  const remasterIdSet = new Set(mai.totalPlateIdList['舞ReMASTER'])
  const buckets = levelBuckets(LEVEL_LIST)
  for (const id of mai.totalPlateIdList['舞']) {
    const s = mai.totalList.byId(id)
    if (!s) continue
    const d = remasterIdSet.has(id) && s.difficulties[4] ? s.difficulties[4] : s.difficulties[3]
    bucketOf(buckets, d.level).songs.push(s)
  }
  const [plus, low] = splitWuBuckets(buckets)
  assert.equal(plateTableLayout(plus, { pages: 0, remasterIdSet }).height, 2614)
  assert.equal(plateTableLayout(low, { pages: 1, remasterIdSet }).height, 3538)
})

test('定数表标签↔定数不变量：x.0–x.5→x、x.6–x.9→x+（仅 level_value ≥ 7）', (t) => {
  if (!ready) return t.skip('曲库未就绪')
  const bad = []
  for (const [label, bucket] of Object.entries(mai.totalLevelData)) {
    for (const ds of Object.keys(bucket)) {
      const v = parseFloat(ds)
      if (v < 7) continue
      const base = Math.floor(v)
      const frac = Math.round((v - base) * 10)
      const expect = frac <= 5 ? String(base) : `${base}+`
      if (label !== expect) bad.push(`${label} 页出现 ${ds}`)
    }
  }
  assert.deepEqual(bad, [], '标签必须由定数派生且不得跨页混入')
})

test('定数表 x / x+ 是两张独立整页，分组与降序锁定', (t) => {
  if (!ready) return t.skip('曲库未就绪')
  assert.deepEqual(Object.keys(mai.totalLevelData['12']), ['12.5', '12.4', '12.3', '12.2', '12.1', '12.0'])
  assert.deepEqual(Object.keys(mai.totalLevelData['12+']), ['12.9', '12.8', '12.7', '12.6'])
  assert.deepEqual(Object.keys(mai.totalLevelData['13']), ['13.5', '13.4', '13.3', '13.2', '13.1', '13.0'])
  assert.deepEqual(Object.keys(mai.totalLevelData['13+']), ['13.9', '13.8', '13.7', '13.6'])
})

// =====================================================================
// 牌子进度（源 plate_table.py:479 DrawPlateProgress）
// =====================================================================

test('displayRowCount：每难度最多 4 行（源 min(...,4)）', () => {
  assert.equal(displayRowCount(0), 1)
  assert.equal(displayRowCount(1), 1)
  assert.equal(displayRowCount(13), 1)
  assert.equal(displayRowCount(14), 2)
  assert.equal(displayRowCount(26), 2)
  assert.equal(displayRowCount(27), 3)
  assert.equal(displayRowCount(39), 3)
  assert.equal(displayRowCount(40), 4)
  assert.equal(displayRowCount(52), 4)
  assert.equal(displayRowCount(500), 4)
})

test('牌子进度：高度与分段推进（起点 455，段间 rows*96+100）', () => {
  const sec = (count) => ({ label: 'x', color: '#fff', count, songs: Array.from({ length: count }, (_, i) => ({ song_id: i })) })
  const lay = plateProgressLayout([sec(0), sec(13), sec(14)])
  // currentY = 395 + (1 + 1 + 2)*96 + 3*100 = 395 + 384 + 300 = 1079 → height = 1079 + 180
  assert.equal(lay.height, 1259)
  assert.equal(lay.card.h, 1079 - 349)
  assert.equal(lay.separatorHeight, 305)
  assert.deepEqual(lay.sections.map(s => s.y), [455, 455 + 1 * 96 + 100, 455 + 1 * 96 + 100 + 1 * 96 + 100])
})

test('牌子进度：≥51 首且剩余不止 1 首 → 中断并出「余 N」提示', () => {
  const songs = Array.from({ length: 60 }, (_, i) => ({ song_id: i }))
  const lay = plateProgressLayout([{ label: 'x', color: '#fff', count: 60, songs }])
  const last = lay.sections[0].cells.at(-1)
  assert.ok(last.overflow !== undefined, '末格应为溢出提示')
  assert.equal(last.overflow, 60 - 51)
  assert.equal(lay.sections[0].cells.length, 52, '51 格曲绘 + 1 格提示')
})

test('牌子进度：恰好剩 1 首时不中断（源 len(result[num:]) != 1）', () => {
  const songs = Array.from({ length: 52 }, (_, i) => ({ song_id: i }))
  const lay = plateProgressLayout([{ label: 'x', color: '#fff', count: 52, songs }])
  assert.equal(lay.sections[0].cells.length, 52, '全 52 格均为曲绘，无溢出提示')
  assert.ok(lay.sections[0].cells.every(c => c.overflow === undefined))
})
