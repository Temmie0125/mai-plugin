import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MaiBase } from '../apps/base.js'

/** 构造期编译 rule 正则（宿主 loader.js:158 同款 new RegExp） */
function rulesOf(cls) {
  const inst = new cls()
  return inst.rule.map(r => ({ ...r, reg: r.reg instanceof RegExp ? r.reg : new RegExp(r.reg) }))
}

const rules = rulesOf(MaiBase)

test('help 规则：命中样例（裸命令/别名/双前缀）', () => {
  const reg = rules.find(r => r.fnc === 'help').reg
  for (const msg of ['#mai', '/mai', '#mai help', '/mai 帮助', '#mai 菜单', '#mai   help ']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
})

test('help 规则：拒收样例（不误吃他人命令）', () => {
  const reg = rules.find(r => r.fnc === 'help').reg
  for (const msg of [
    '#maib50', // 无空格粘连
    '#mai help me', // 带多余参数
    '#maihelpx',
    '#phi b19', // 其他插件命令
    '#更新maimai数据',
    'mai help', // 无前缀（保留给口语正则，基命令不响应）
    '#帮助maimaiDX', // 原版触发词不保留（收编进 #mai）
  ]) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('默认 cmdhead 与规则一致', async () => {
  const { head } = await import('../lib/config.js')
  const reg = rules.find(r => r.fnc === 'help').reg
  assert.match(`#${head()}`, reg)
})

test('改 cmdhead 重启后规则跟随新命令头', async () => {
  const { default: Config, head } = await import('../lib/config.js')
  Config.modify('config', 'cmdhead', 'maimaidx')
  const inst = new MaiBase()
  const reg = new RegExp(inst.rule[0].reg)
  assert.match('#maimaidx help', reg)
  assert.doesNotMatch('#mai help', reg)
  Config.modify('config', 'cmdhead', 'mai')
})
