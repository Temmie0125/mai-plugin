/**
 * P2c 命令规则：上分推荐（rise / 口语「我要上X分」）与分数线（fsline）
 * 只覆盖不触网路径：正则命中/拒收、前置守卫文案。
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

let MaiRise = null
let MaiRiseSay = null
let MaiGlobal = null

function rulesOf(cls) {
  const inst = new cls()
  return inst.rule.map(r => ({ ...r, reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg) }))
}
function makeInst(cls) {
  const inst = new cls()
  const replies = []
  inst.reply = async (msg) => { replies.push(String(msg)) }
  return { inst, replies }
}

test('准备：载入 apps/fun.js 与 apps/global.js', async () => {
  // ⚠️ 这两行都必须带分号：以 `(` 开头的语句若上一行也是表达式语句，
  // ASI 不生效 → 被解析成「调用上一行的结果」，报 is not a function
  ({ MaiRise, MaiRiseSay } = await import('../apps/fun.js'));
  ({ MaiGlobal } = await import('../apps/global.js'));
})

test('rise 规则：命中与拒收', () => {
  const reg = rulesOf(MaiRise).find(r => r.fnc === 'riseScore').reg
  for (const msg of ['#mai rise', '#mai rise 13', '#mai rise 13 20', '#mai 推分 14 5', '#mairise 13']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['#mai risex 13', '#phi rise 13', 'rise 13']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('口语上分规则：命中与拒收（源 rise_score 免前缀形态）', () => {
  const reg = rulesOf(MaiRiseSay).find(r => r.fnc === 'riseSay').reg
  // 「我要上分」也命中（源各分组皆可选）→ 等价于不带等级/分数的推荐
  for (const msg of ['我要上20分', '我要在13+上1分', '我要加5分', '我要在14上10分', '我要在14加10分', '我要上分']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of [
    '今天天气不错', '我上20分', '想要上分',
    // 源正则的 `[上加\+]` 只吃**一个**分隔字，故「上+加」连用源本身就不匹配（已与 Python 复核）
    '我要在14上加10分',
  ]) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('rise 守卫：非法等级 → 无此等级（源无句号）', async () => {
  const { inst, replies } = makeInst(MaiRise)
  for (const lv of ['99', '16', 'abc']) {
    replies.length = 0
    await inst.riseScore({ msg: `#mai rise ${lv} 20` })
    assert.deepEqual(replies, ['无此等级'], `lv=${lv}`)
  }
})

test('口语上分守卫：非法等级 → 无此等级', async () => {
  const { inst, replies } = makeInst(MaiRiseSay)
  replies.length = 0
  await inst.riseSay({ msg: '我要在99上1分' })
  assert.deepEqual(replies, ['无此等级'])
})

test('解析：等级可省、分数可省（源 score 为 None 时不 int()）', async () => {
  const { parseRiseArgs } = await import('../apps/fun.js')
  assert.deepEqual(parseRiseArgs(undefined, undefined), { level: null, score: null })
  assert.deepEqual(parseRiseArgs('13', ''), { level: '13', score: null })
  assert.deepEqual(parseRiseArgs('13+', '20'), { level: '13+', score: 20 })
})

test('fsline 规则：命中与拒收', () => {
  const reg = rulesOf(MaiGlobal).find(r => r.fnc === 'fsline').reg
  for (const msg of ['#mai fsline', '#mai fsline 紫799 100', '#mai 分数线 白799 99.5', '#maifsline 紫799 100']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['#mai fslinex 紫799 100', '#phi fsline a b', '分数线 紫799 100']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('fsline 守卫：帮助分支 / 缺难度色 / 非法达成率 → 格式错误', async () => {
  const { inst, replies } = makeInst(MaiGlobal)
  const { FSLINE_HELP, FSLINE_FORMAT_ERROR } = await import('../lib/handler.js')

  replies.length = 0
  await inst.fsline({ msg: '#mai fsline 帮助' })
  assert.deepEqual(replies, [FSLINE_HELP], '帮助应发文本')

  for (const msg of [
    '#mai fsline',            // 全缺
    '#mai fsline 799 100',    // 缺难度色
    '#mai fsline 紫',         // 缺达成率
    '#mai fsline 紫799',      // 只有难度色+id，无达成率
    '#mai fsline 紫799 abc',  // 达成率非数
    '#mai fsline 紫999999 100', // id 不存在
  ]) {
    replies.length = 0
    await inst.fsline({ msg })
    assert.deepEqual(replies, [FSLINE_FORMAT_ERROR], `msg=${msg}`)
  }
})
