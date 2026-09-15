/**
 * 拟合 B50 的**版式接线**单测（设计《拟合b50实现设计.md》§6）
 *
 * 为什么单独做视图层断言：真正的出图核验要跑 puppeteer（tests/render-fitb50.mjs，
 * 需本机浏览器），而「称号位是否被换成拟合合计行」「定数行是否用 2 位小数」
 * 这两件事完全可以在视图对象上离线断言。二者互补：
 * 本文件锁**接线正确**，冒烟脚本锁**视觉无溢出**。
 *
 * 不触网、不落盘、不起浏览器。
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

const { b50View } = await import('../lib/render/views.js')
const { mai } = await import('../lib/service.js')

const PLAYER = { name: 'テスト', rating: 15234, course_rank: 5, class_rank: 3, trophy: null, icon: null, name_plate: null }

/** 一条成绩；level_value/rating 由调用方按口径给（拟合口径 vs 真实口径） */
const item = (song_id, level_index, level_value, rating) => ({
  song_id, level_index, level_value, rating,
  song_name: `S${song_id}`, level: '13', type: 'SD',
  achievements: 100.5, rate: 'sssp', fc: null, fs: null, dx_score: 0,
})

const BEST50 = {
  sd_total: 300, dx_total: 200,
  sd: [item(1, 3, 4.0895606834601415, 92)],
  dx: [item(10001, 3, 12.5, 281)],
}

const textsOf = view => view.texts.map(t => t.text)
const findText = (view, needle) => textsOf(view).find(t => t.includes(needle))

/** 造一条 level_index→定数 的曲库映射（非 fit 分支读它） */
function withTotalLevelValueMap(map, fn) {
  const saved = mai.totalLevelValueMap
  mai.totalLevelValueMap = map
  try {
    return fn()
  } finally {
    mai.totalLevelValueMap = saved
  }
}

test('fit 模式：称号位换成拟合合计行，不展示真实 rating / 称号', () => {
  const view = b50View({
    player: PLAYER, best50: BEST50, serviceName: 'Lxns-Network', botName: 'MaiTest',
    fit: true, fitTotal: 500,
  })
  assert.ok(textsOf(view).includes('拟合 B35: 300 + B15: 200 = 500'),
    `应出现拟合合计行，实际文案：${JSON.stringify(textsOf(view))}`)
  // 真实 B50 的合计行（末端为 player.rating）必须不出现
  assert.ok(!findText(view, `= ${PLAYER.rating}`), '不应出现真实 rating 的合计行')
})

test('fit 模式：定数行用拟合定数（2 位小数）+ 拟合 rating', () => {
  const view = b50View({
    player: PLAYER, best50: BEST50, serviceName: 'df', botName: 'MaiTest',
    fit: true, fitTotal: 500,
  })
  // pyRound2(4.0895606834601415) === '4.09'；rating 为 fitBest50 算出的 92
  assert.ok(findText(view, '4.09 -> 92'), `定数行应为拟合口径，实际：${JSON.stringify(textsOf(view))}`)
  assert.ok(findText(view, '12.5 -> 281'), 'B15 侧同样取拟合定数')
})

test('非 fit 模式：定数行仍读当前曲库、用 pyFloat 口径（既有行为不回归）', () => {
  withTotalLevelValueMap({ '1-3': 13, '10001-3': 12.5 }, () => {
    const view = b50View({
      player: PLAYER, best50: BEST50, serviceName: 'df', botName: 'MaiTest',
    })
    // pyFloat(13) === '13.0'（整值带 .0）——与 fit 模式的 '4.09' 形态刻意不同
    assert.ok(findText(view, '13.0 -> 92'), `非 fit 应读曲库定数，实际：${JSON.stringify(textsOf(view))}`)
    assert.ok(findText(view, '12.5 -> 281'))
    // 无 trophy 时回落真实合计行
    assert.ok(textsOf(view).includes(`B35: 300 + B15: 200 = ${PLAYER.rating}`),
      '非 fit 且无称号时应回落真实合计行')
  })
})

test('非 fit 模式：有真实称号时展示称号名（fit 模式则被替换）', () => {
  const withTrophy = { ...PLAYER, trophy: { id: 1, name: 'れっつゴー！', color: 'Rainbow' } }
  const plain = b50View({ player: withTrophy, best50: BEST50, serviceName: 'df', botName: 'b' })
  assert.ok(textsOf(plain).includes('れっつゴー！'), '非 fit 应展示真实称号')

  const fitted = b50View({
    player: withTrophy, best50: BEST50, serviceName: 'df', botName: 'b', fit: true, fitTotal: 500,
  })
  assert.ok(!textsOf(fitted).includes('れっつゴー！'), 'fit 模式不展示真实称号')
  assert.ok(textsOf(fitted).includes('拟合 B35: 300 + B15: 200 = 500'))
})

test('变体模式：称号位换成条件合计（右端为 x+y，不是真实 rating），变体名走横幅行', () => {
  const view = b50View({
    player: PLAYER, best50: BEST50, serviceName: 'Diving-Fish', botName: 'MaiTest',
    variantLabel: 'FC',
  })
  const texts = textsOf(view)
  assert.ok(texts.includes('B35: 300 + B15: 200 = 500'),
    `称号位应为条件合计，实际：${JSON.stringify(texts)}`)
  assert.ok(!findText(view, `= ${PLAYER.rating}`),
    '右端不得再写玩家真实 Rating（与左侧条件合计不同源，见设计 V9）')
  // 变体名在横幅行（y=213），不在称号框内
  const banner = view.texts.find(t => t.text === 'FC')
  assert.ok(banner, '应出现变体名横幅')
  assert.equal(banner.y, 213, '横幅画在称号框下方留白处')
  assert.equal(banner.x, 700)
  // 真实称号即使存在也被替换（与 fit 模式同款语义）
  const withTrophy = { ...PLAYER, trophy: { id: 1, name: 'れっつゴー！', color: 'Rainbow' } }
  const fitted = b50View({
    player: withTrophy, best50: BEST50, serviceName: 'df', botName: 'b', variantLabel: '其他游戏',
  })
  assert.ok(!textsOf(fitted).includes('れっつゴー！'), '变体模式不展示真实称号')
  assert.ok(textsOf(fitted).includes('其他游戏'), '长变体名（4 字）原样进横幅，不截断')
})

test('变体模式：定数行仍是真实口径（不走 fit 的拟合定数分支）', () => {
  withTotalLevelValueMap({ '1-3': 13, '10001-3': 12.5 }, () => {
    const view = b50View({
      player: PLAYER, best50: BEST50, serviceName: 'df', botName: 'b', variantLabel: '东方',
    })
    assert.ok(findText(view, '13.0 -> 92'), '定数行读当前曲库（pyFloat 口径）')
    assert.ok(findText(view, '12.5 -> 281'))
  })
})

test('两模式共同项不变：头部 rating 数字图、页脚数据源、成绩条数', () => {
  withTotalLevelValueMap({ '1-3': 13, '10001-3': 12.5 }, () => {
    const opts = { player: PLAYER, best50: BEST50, serviceName: 'Diving-Fish', botName: 'MaiTest' }
    const plain = b50View(opts)
    const fitted = b50View({ ...opts, fit: true, fitTotal: 500 })

    assert.equal(plain.width, 1400)
    assert.equal(plain.height, 1600, 'fit 不改变画布尺寸（模板无需改）')
    assert.equal(fitted.width, 1400)
    assert.equal(fitted.height, 1600)

    // 头部真实 rating 逐位数字图：两模式一致（D1 明确头部保留真实值）
    const digitSrcs = v => v.images.map(i => i.src).filter(s => s.includes('UI_NUM_Drating_'))
    assert.equal(digitSrcs(fitted).length, String(PLAYER.rating).length)
    assert.deepEqual(digitSrcs(fitted), digitSrcs(plain))

    for (const v of [plain, fitted]) {
      assert.ok(findText(v, 'Data from Diving-Fish'), '页脚数据源两模式一致')
    }
  })
})
