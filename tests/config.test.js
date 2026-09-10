import { test } from 'node:test'
import assert from 'node:assert/strict'
import Config, { head } from '../lib/config.js'

/**
 * 临时覆盖用户配置跑一段。只改 Config 的内存缓存，**不写用户 yaml**——
 * tests/*.test.js 由 node --test 多进程并行，谁写 config/config/config.yaml
 * 都会与其它文件互相覆盖（并可能把临时值留在真机配置里）。
 */
function withUserCfg(patch, fn) {
  try {
    Config.config.config = { ...Config.getConfig('config'), ...patch }
    return fn()
  } finally {
    delete Config.config.config // 丢弃缓存，下次读取回落到磁盘上的真实用户配置
  }
}

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
  withUserCfg({ cmdhead: 'mai.test' }, () => assert.equal(head(), 'mai\\.test'))
  assert.equal(head(), 'mai', '覆盖退出后应还原')
})

test('改 cmdhead 后配置读取即时生效（模拟重启后 rule 重建）', () => {
  withUserCfg({ cmdhead: 'maidx' }, () => {
    assert.equal(head(), 'maidx')
    const re = new RegExp(`^[#/]${head()}(\\s+(help|帮助|菜单))?\\s*$`)
    assert.match('#maidx help', re)
    assert.doesNotMatch('#mai help', re)
  })
  assert.equal(head(), 'mai')
})

test('定时项：默认开启自动同步，时间为 05:30（避开 04:00–04:30 窗口）', () => {
  const def = Config.getdefSet('config')
  assert.equal(def.autoSync, true)
  assert.equal(def.autoSyncTime, '05:30')
  // yaml 里必须是字符串：TimePicker 之类的编辑器组件会写成 Date/数组，导致解析静默失败
  assert.equal(typeof def.autoSyncTime, 'string')
})
