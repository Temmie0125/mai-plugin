/**
 * calc/constants 纯函数单测（设计 §十二：算分样例锁值）
 * 样例对照源 core/utils/calc.py 手算结果。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeRating, dxStar, getBaseRa, qqhash } from '../lib/calc.js'
import { RANK_MAP, RANK_PLUS, COMBO_MAP, SYNC_MAP, LEVEL_INDEX_MAP, DX_CN_VERSION } from '../lib/constants.js'
import { coloumWidth, changeColumnWidth, pyFloat, pyRound2 } from '../lib/render/textwidth.js'

test('computeRating 基础档位', () => {
  // D 档 (<50)：ds=13.6, acc=40 → floor(13.6*0.4*7.0)=38
  assert.equal(computeRating(13.6, 40), 38)
  assert.equal(computeRating(13.6, 40, { onlyrate: true }), 'D')
  // SS 档 (<99.5，base=20.8)：ds=13.6, acc=99.4
  assert.equal(computeRating(13.6, 99.4), Math.floor(13.6 * 0.994 * 20.8))
  // SSSp 档（≥100.5，acc 截断 100.5，base=22.4）：acc=101
  assert.equal(computeRating(14.0, 101), Math.floor(14.0 * 1.005 * 22.4))
  // israte 返回 [ra, rate]；acc=100.5 落 SSSp（Python: 不满足 <100.5）
  const [ra, rate] = computeRating(15.0, 100.5, { israte: true })
  assert.equal(rate, 'SSSp')
  assert.equal(ra, Math.floor(15.0 * 1.005 * 22.4))
})

test('dxStar 阈值', () => {
  assert.equal(dxStar(85), 0)
  assert.equal(dxStar(85.1), 1)
  assert.equal(dxStar(90), 1)
  assert.equal(dxStar(93), 2)
  assert.equal(dxStar(95), 3)
  assert.equal(dxStar(97), 4)
  assert.equal(dxStar(97.1), 5)
})

test('getBaseRa 阈值表', () => {
  assert.equal(getBaseRa(49.9), 7.0)
  assert.equal(getBaseRa(93.9), 15.2)
  assert.equal(getBaseRa(100.5), 22.4)
})

test('常量表派生（RANK_MAP/COMBO_MAP/SYNC_MAP 与源一致）', () => {
  assert.equal(RANK_MAP.ssp, 'SSp')
  assert.equal(RANK_MAP.sssp, 'SSSp')
  assert.equal(RANK_MAP.s, 'S')
  assert.deepEqual(RANK_PLUS, ['d', 'c', 'b', 'bb', 'bbb', 'a', 'aa', 'aaa', 's', 's+', 'ss', 'ss+', 'sss', 'sss+'])
  assert.equal(COMBO_MAP.fc, 'FC')
  assert.equal(COMBO_MAP.fcp, 'FCp')
  assert.equal(COMBO_MAP.ap, 'AP')
  assert.equal(SYNC_MAP.fdx, 'FSD')
  assert.equal(SYNC_MAP.fdxp, 'FSDp')
  assert.equal(LEVEL_INDEX_MAP['14+'], 21)
  assert.equal(DX_CN_VERSION['舞萌DX 2026'][1], 'maimai でらっくす PRiSM PLUS')
})

test('qqhash 与 Python 实现一致（固定日期锁值）', () => {
  // Python: days=(d+31*m+77); (days*qq)>>8 —— 日期注入口固定 2026-09-09，跨天不失效
  const fixed = new Date(2026, 8, 9)
  const days = 9 + 31 * 9 + 77
  assert.equal(qqhash(114514, fixed), Number((BigInt(days) * 114514n) >> 8n))
  // 大数不丢精度
  const big = (BigInt(days) * BigInt(1145141919)) >> 8n
  assert.ok(big < 2n ** 53n)
  // 同日恒定、异日变化（源「同人同签、日变」语义）
  assert.equal(qqhash(114514, fixed), qqhash(114514, new Date(2026, 8, 9, 23, 59)))
  assert.notEqual(qqhash(114514, fixed), qqhash(114514, new Date(2026, 8, 10)))
})

test('半角宽度度量（源 coloum_width 表）', () => {
  assert.equal(coloumWidth('abc'), 3)
  assert.equal(coloumWidth('中文'), 4)
  assert.equal(coloumWidth('１２'), 4) // 全角数字
  assert.equal(coloumWidth('a中'), 3)
  assert.equal(changeColumnWidth('中中中中', 6), '中中中')
  assert.equal(changeColumnWidth('abcd', 3), 'abc')
})

test('pyFloat/pyRound2 与 Python str(float)/round 对齐', () => {
  assert.equal(pyFloat(5), '5.0')
  assert.equal(pyFloat(13.5), '13.5')
  assert.equal(pyRound2(12.303326), '12.3')
  assert.equal(pyRound2(5.0), '5.0')
})
