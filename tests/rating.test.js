import { test } from 'node:test'
import assert from 'node:assert/strict'

import { computeRating, getBaseRa } from '../lib/calc.js'
import { MaiRating, parseComArgs, formatComResult, comUsage, COM_ERROR_TEXT } from '../apps/rating.js'

// 宿主全局 logger 打桩（apps 模块经 plugin.js 基类可能触达，与 fortune.test.js 同款）
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

test('parseComArgs：常规两段参数，达成率容忍尾随 % 与多余空白', () => {
  assert.deepEqual(parseComArgs('13.6 100.5'), { ds: 13.6, acc: 100.5 })
  assert.deepEqual(parseComArgs('13.6 100.5%'), { ds: 13.6, acc: 100.5 })
  assert.deepEqual(parseComArgs('  14   99.5  '), { ds: 14, acc: 99.5 })
  // 原版口径：只取前两段，多余参数忽略
  assert.deepEqual(parseComArgs('13.6 100.5 多余'), { ds: 13.6, acc: 100.5 })
})

test('parseComArgs：缺参/非数字/越界分别回 usage/nan/ds/acc', () => {
  assert.equal(parseComArgs('').error, 'usage')
  assert.equal(parseComArgs('13.6').error, 'usage')
  assert.equal(parseComArgs('abc 100').error, 'nan')
  assert.equal(parseComArgs('13.6 xyz').error, 'nan')
  assert.equal(parseComArgs('15.5 100').error, 'ds', '定数上限 15（原版口径）')
  assert.equal(parseComArgs('-1 100').error, 'ds')
  assert.equal(parseComArgs('13.6 101.1').error, 'acc', '达成率上限 101（原版口径）')
  assert.equal(parseComArgs('13.6 -0.1').error, 'acc')
  // 边界内放行
  assert.deepEqual(parseComArgs('15 101'), { ds: 15, acc: 101 })
  assert.deepEqual(parseComArgs('0 0'), { ds: 0, acc: 0 })
})

test('formatComResult：锚点值与原 maicom.js 同口径（分档/系数/取整）', () => {
  // 官方锚点：SSSp 满配 13.6 → 306
  assert.equal(
    formatComResult(13.6, 100.5),
    ['谱面定数：13.6', '达成率：100.5000%', '评级系数：22.4', '评价：SSSp', 'DX Rating：306'].join('\n'),
  )
  // 100.0 → SSS（21.6），floor(13×21.6)=280
  assert.match(formatComResult(13, 100), /评级系数：21\.6\n评价：SSS\nDX Rating：280$/)
  // 99.5 → SSp（21.1，含等号边界：99.5 不再属于 SS 档），floor(14×0.995×21.1)=293
  assert.match(formatComResult(14, 99.5), /评级系数：21\.1\n评价：SSp\nDX Rating：293$/)
  // 50.0 整点 → C（8.0，含等号边界），floor(12×0.5×8)=48
  assert.match(formatComResult(12, 50), /评级系数：8\n评价：C\nDX Rating：48$/)
  // D 档（<50）
  assert.match(formatComResult(7, 49.9), /评级系数：7\n评价：D\nDX Rating：24$/)
})

test('formatComResult：>100.5 截断按 100.5 计（原版口径），101 与 100.5 同分', () => {
  const a = formatComResult(15, 101)
  const b = formatComResult(15, 100.5)
  // 回显行如实显示 101，评分行（系数/评价/Rating）与 100.5 完全一致
  assert.match(a, /达成率：101\.0000%\n评级系数：22\.4\n评价：SSSp\nDX Rating：337$/)
  assert.equal(a.replace('达成率：101.0000%', ''), b.replace('达成率：100.5000%', ''))
})

test('formatComResult：展示的评级系数/评价必与 lib/calc.js 的分档自洽', () => {
  // 展示系数来自 getBaseRa，评分来自 computeRating 内部表——两处必须永不相悖
  for (const acc of [0, 49.99, 50, 60, 70, 75, 80, 90, 94, 97, 98, 99, 99.5, 100, 100.5, 101]) {
    const text = formatComResult(10, acc)
    const [rating, rate] = computeRating(10, acc, { israte: true })
    const shownCoeff = Number(text.match(/评级系数：([\d.]+)\n/)[1])
    assert.equal(shownCoeff, getBaseRa(acc), `acc=${acc} 展示系数应等于 getBaseRa`)
    assert.ok(text.includes(`评价：${rate}\n`), `acc=${acc} 评价行应等于 computeRating 分档`)
    assert.ok(text.endsWith(`DX Rating：${rating}`), `acc=${acc} 取整值应等于 computeRating`)
  }
})

test('comUsage / COM_ERROR_TEXT：沿用原 maicom.js 文案', () => {
  assert.equal(comUsage('mai'), '格式错误QAQ！\n格式：#mai com <定数> <达成率>')
  assert.equal(COM_ERROR_TEXT.nan, '定数或达成率格式错误，应为数字！')
  assert.equal(COM_ERROR_TEXT.ds, '定数应在0~15之间！')
  assert.equal(COM_ERROR_TEXT.acc, '达成率应在0.0000%~101.0000%之间！')
})

test('规则：命中 com / calc / 计算三个别名与 # / / 两种前缀', () => {
  const reg = new RegExp(new MaiRating().rule[0].reg)
  for (const msg of ['#mai com 13.6 100.5', '#mai calc 13.6 100.5', '#mai 计算 13.6 100.5',
    '/mai com 13.6 100.5', '#mai  com 13.6 100.5', '#mai com 13.6 100.5%',
    '#mai 计算 13.6 100.5 ', '#mai com']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['#phi com 13.6 100.5', '#mai computer 13.6 100.5', '#mai com13.6 100.5',
    '#mai help', '#mai']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('规则：priority 100 的普通子命令，单规则', () => {
  const app = new MaiRating()
  assert.equal(app.priority, 100)
  assert.equal(app.rule.length, 1)
  assert.equal(app.rule[0].fnc, 'com')
})
