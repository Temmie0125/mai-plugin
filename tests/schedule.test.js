import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hhmmToCron, toHhmm, resolveAutoSyncCron, DEFAULT_AUTO_SYNC_TIME,
} from '../lib/schedule.js'

test('hhmmToCron：合法值、补零与宽松格式', () => {
  assert.equal(hhmmToCron('05:30'), '0 30 5 * * *')
  assert.equal(hhmmToCron('00:00'), '0 0 0 * * *')
  assert.equal(hhmmToCron('23:59'), '0 59 23 * * *')
  assert.equal(hhmmToCron('5:30'), '0 30 5 * * *', '一位数小时应接受并补零')
  assert.equal(hhmmToCron('5:7'), '0 7 5 * * *', '一位数分钟同样接受（刻意宽于文档 §12.1 样例）')
  assert.equal(hhmmToCron('  05:30  '), '0 30 5 * * *', '首尾空白应忽略')
  assert.equal(hhmmToCron('5：30'), '0 30 5 * * *', '全角冒号应接受')
})

test('hhmmToCron：越界与不可解析一律 null', () => {
  const bad = ['25:00', '24:00', '12:60', '23:99', '', '   ', 'abc',
    '5:30:00', '05-30', '05 30', '5.30', null, undefined, {}, []]
  for (const v of bad) {
    assert.equal(hhmmToCron(v), null, `应判非法：${JSON.stringify(v)}`)
  }
})

test('toHhmm：归一为两位 HH:MM，非法为 null', () => {
  assert.equal(toHhmm('5:7'), '05:07')
  assert.equal(toHhmm('23:59'), '23:59')
  assert.equal(toHhmm('7:05'), '07:05')
  assert.equal(toHhmm('25:00'), null)
  assert.equal(toHhmm(''), null)
})

test('resolveAutoSyncCron：合法值原样生效且不标回退', () => {
  assert.deepEqual(resolveAutoSyncCron('5:30'), {
    cron: '0 30 5 * * *', time: '05:30', fallback: false,
  })
  assert.deepEqual(resolveAutoSyncCron('23:59'), {
    cron: '0 59 23 * * *', time: '23:59', fallback: false,
  })
})

test('resolveAutoSyncCron：非法值回退默认并标记 fallback（不注册错误 cron）', () => {
  // 用户拍板：回退默认照常注册，笔误不该让每日同步静默停摆
  for (const v of ['25:00', '12:60', '', '   ', '乱填', null, undefined]) {
    const r = resolveAutoSyncCron(v)
    assert.equal(r.fallback, true, `应标记回退：${JSON.stringify(v)}`)
    assert.equal(r.time, DEFAULT_AUTO_SYNC_TIME, '回退到出厂默认时间')
    assert.equal(r.cron, '0 30 5 * * *', '回退后的 cron 必须是合法的默认值')
  }
})

test('默认时间为 05:30（避开 04:00–04:30 的常见更新窗口）', () => {
  assert.equal(DEFAULT_AUTO_SYNC_TIME, '05:30')
  assert.equal(hhmmToCron(DEFAULT_AUTO_SYNC_TIME), '0 30 5 * * *')
})
