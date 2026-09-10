import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHelpData } from '../lib/render/picmodle.js'

test('帮助数据：{head} 占位符替换为当前命令头', () => {
  const data = buildHelpData('maidx', 'v0.1.0')
  assert.equal(data.cmdHead, 'maidx')
  const all = data.groups.flatMap(g => g.list)
  assert.ok(all.length >= 20, '命令清单不应为空')
  for (const item of all) {
    assert.ok(!item.title.includes('{head}'), 'title 不应残留占位符')
    assert.ok(!item.eg.includes('{head}'), 'eg 不应残留占位符')
    // desc 也必须替换：漏掉会把字面量 {head} 印到帮助图上（fsline 条目曾如此）
    assert.ok(!String(item.desc ?? '').includes('{head}'), `desc 不应残留占位符：${item.title}`)
  }
  assert.ok(all.some(i => i.eg.includes('#maidx')), '示例应包含新命令头')
})

test('帮助数据：默认命令头与分组结构', () => {
  const data = buildHelpData('mai')
  assert.ok(data.groups.length >= 5)
  for (const g of data.groups) {
    assert.ok(g.group && g.list.length > 0)
  }
  assert.match(data.copyright, /Yuri-YuzuChaN/)
  assert.match(data.copyright, /mai-bot/)
})
