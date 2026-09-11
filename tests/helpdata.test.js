import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildHelpData, HELP_TAG_DEFS } from '../lib/render/picmodle.js'

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

test('帮助数据：permission/scene → desc 前缀徽章 tags（顺序恒为 权限→场景）', () => {
  const data = buildHelpData('mai')
  const all = data.groups.flatMap(g => g.list)
  const known = Object.values(HELP_TAG_DEFS)
  const tagOf = item => item.tags.map(t => t.label).join('')

  // 徽章只出自四种已知定义；无字段条目 → 空数组（模板 {{if item.tags.length}} 分支不渲染）
  for (const item of all) {
    for (const t of item.tags) assert.ok(known.includes(t), `未知徽章：${JSON.stringify(t)}`)
  }
  assert.ok(all.some(i => i.tags.length === 0), '应存在不带徽章的普通条目')

  // help.json 现状逐条锁值（sync 实际检查 e.isMaster，是 master 而非 admin）
  const byEg = Object.fromEntries(all.filter(i => i.tags.length).map(i => [i.eg.split('\n')[0], tagOf(i)]))
  assert.equal(byEg['#mai 更新'], 'M')
  assert.equal(byEg['#mai 强制更新'], 'M')
  assert.equal(byEg['#mai download'], 'M')
  assert.equal(byEg['#mai sync'], 'M')
  assert.equal(byEg['#mai alias sync'], 'M')
  assert.equal(byEg['#mai push on'], 'AG')
  assert.equal(byEg['#mai push global on'], 'M')
  assert.equal(byEg['#mai guess on'], 'AG')
  assert.equal(byEg['#mai ans'], 'AG')
})
