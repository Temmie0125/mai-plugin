import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MaiManage } from '../apps/manage.js'

function rulesOf(cls) {
  const inst = new cls()
  return inst.rule.map(r => ({ reg: new RegExp(r.reg), fnc: r.fnc }))
}

test('更新规则：命中样例（普通/强制/别名/双前缀）', () => {
  const rules = rulesOf(MaiManage)
  assert.equal(rules.length, 1)
  const reg = rules[0].reg
  for (const msg of ['#mai 更新', '#mai 强制更新', '#mai gx', '/mai update', '#mai   强制   更新']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
})

test('更新规则：强制分组捕获（决定 reset/clean 分支）', () => {
  const reg = rulesOf(MaiManage)[0].reg
  const m = '#mai 强制更新'.match(reg)
  assert.equal(m?.[1], '强制')
  assert.equal('#mai 更新'.match(reg)?.[1], undefined)
})

test('更新规则：拒收样例', () => {
  const reg = rulesOf(MaiManage)[0].reg
  for (const msg of ['#mai 强制', '#mai 更新曲绘', '#maix 更新', 'mai 更新', '#mai sync', '#phi 更新']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('更新命令：非主人拒绝', async () => {
  const inst = new MaiManage()
  const replies = []
  inst.reply = async m => replies.push(typeof m === 'string' ? m : '…')
  const e = {
    msg: '#mai 更新', message: [], user_id: 114514, isGroup: false,
    isMaster: false, reply: async () => {},
  }
  const ret = await inst.update(e)
  assert.equal(ret, true)
  assert.match(replies.join(''), /仅主人可用/)
})

test('gitErrText：中文分流（冲突/网络/未知）', () => {
  const inst = new MaiManage()
  assert.match(inst.gitErrText(new Error('CONFLICT content')), /本地改动冲突/)
  assert.match(inst.gitErrText(new Error('Failed to connect to github.com')), /连接远程仓库失败/)
  assert.match(inst.gitErrText(new Error('cannot pull without a remote')), /git 仓库\/远程异常/)
  assert.match(inst.gitErrText(new Error('some random error')), /some random error/)
})
