import { test } from 'node:test'
import assert from 'node:assert/strict'
import Config, { head } from '../lib/config.js'

test('出厂默认配置可读且关键 key 存在', () => {
  const def = Config.getdefSet('config')
  assert.equal(def.cmdhead, 'mai')
  assert.equal(typeof def.renderQuality, 'number')
  assert.equal(typeof def.aliasPush, 'boolean')
})

test('静态资源项：仓库地址有出厂默认，自动更新默认开启', () => {
  const def = Config.getdefSet('config')
  assert.equal(def.assetsRepo, 'https://github.com/Temmie0125/mai-plugin-resource-static.git')
  assert.equal(def.autoUpdateAssets, true)
})

test('用户副本 yaml 已自动生成（initCfg 复制）', () => {
  const user = Config.getUserCfg('config')
  assert.equal(user.cmdhead, 'mai')
})

test('cmdhead 特殊字符在正则场景被转义', () => {
  // 默认 mai 无需转义
  assert.equal(head(), 'mai')
  // 含正则元字符的命令头必须转义，否则 rule 构造期 new RegExp 会出错
  Config.modify('config', 'cmdhead', 'mai.test')
  assert.equal(head(), 'mai\\.test')
  // 恢复
  Config.modify('config', 'cmdhead', 'mai')
  assert.equal(head(), 'mai')
})

test('改 cmdhead 后配置读取即时生效（模拟重启后 rule 重建）', () => {
  Config.modify('config', 'cmdhead', 'maidx')
  assert.equal(head(), 'maidx')
  const re = new RegExp(`^[#/]${head()}(\\s+(help|帮助|菜单))?\\s*$`)
  assert.match('#maidx help', re)
  assert.doesNotMatch('#mai help', re)
  Config.modify('config', 'cmdhead', 'mai')
  assert.equal(head(), 'mai')
})
