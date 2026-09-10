/**
 * 完成表数据层单测（lib/tableData.js 的牌子部分）
 * 纯函数部分离线可跑；涉及真实曲库的用例在无缓存时跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPlateQualified, processPlateTable } from '../lib/tableData.js'
import { LEVEL_LIST } from '../lib/constants.js'

if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

const play = (o = {}) => ({ achievements: 100, fc: null, fs: null, level_value: 13.0, ...o })

// =====================================================================
// isPlateQualified（源 plate_table.py:120）
// =====================================================================

test('将：achievements >= 100（边界含 100）', () => {
  assert.equal(isPlateQualified(play({ achievements: 100 }), '将'), true)
  assert.equal(isPlateQualified(play({ achievements: 99.9999 }), '将'), false)
})

test('者：achievements >= 80（边界含 80）', () => {
  assert.equal(isPlateQualified(play({ achievements: 80 }), '者'), true)
  assert.equal(isPlateQualified(play({ achievements: 79.9 }), '者'), false)
})

test('极/極：fc 属于 COMBO_SP（fc/fcp/ap/app）', () => {
  for (const p of ['极', '極']) {
    for (const fc of ['fc', 'fcp', 'ap', 'app']) assert.equal(isPlateQualified(play({ fc }), p), true, `${p}/${fc}`)
    for (const fc of [null, '', 'fs']) assert.equal(isPlateQualified(play({ fc }), p), false, `${p}/${fc}`)
  }
})

test('神：fc 仅 ap/app', () => {
  assert.equal(isPlateQualified(play({ fc: 'ap' }), '神'), true)
  assert.equal(isPlateQualified(play({ fc: 'app' }), '神'), true)
  assert.equal(isPlateQualified(play({ fc: 'fc' }), '神'), false)
  assert.equal(isPlateQualified(play({ fc: 'fcp' }), '神'), false)
})

test('舞舞：fs 属于 [fsd, fsdp, fsdpx, fsdp+]', () => {
  for (const fs of ['fsd', 'fsdp', 'fsdpx', 'fsdp+']) assert.equal(isPlateQualified(play({ fs }), '舞舞'), true, fs)
  for (const fs of [null, 'fs', 'fsp', 'sync']) assert.equal(isPlateQualified(play({ fs }), '舞舞'), false, String(fs))
})

test('未游玩 / 未知计划 → 一律不达标', () => {
  assert.equal(isPlateQualified(null, '将'), false)
  assert.equal(isPlateQualified(undefined, '极'), false)
  assert.equal(isPlateQualified(play({ achievements: 101 }), '不存在的称号'), false)
})

// =====================================================================
// processPlateTable（源 plate_table.py:231）—— 真实曲库
// =====================================================================

let mai = null
let ready = false
test('载入曲库（离线）', async () => {
  ({ mai } = await import('../lib/service.js'))
  if (!mai.ready) await mai.init({ network: false }).catch(() => false)
  ready = mai.ready
})

const call = (o) => processPlateTable({
  plateIdList: mai.totalPlateIdList, totalList: mai.totalList, ...o,
})

test('非舞分支：总数取 plate id 数，槽位恒 4，等级序为 reversed(LEVEL_LIST) 子集', (t) => {
  if (!ready) return t.skip('曲库未就绪')
  const data = call({ version: '真', versionName: '真', isWu: false, page: 1, plan: '将', playResult: [] })
  assert.equal(data.totalCount, mai.totalPlateIdList['真'].length)
  assert.equal(data.remasterCount, 0)
  assert.equal(data.slotCounts.length, 4)
  assert.deepEqual(data.displayLevels, [...data.levels.keys()], '非舞：全部等级都在当前页')
  // 等级键序必须是 reversed(LEVEL_LIST) 的子集且保序（源 _get_level_dict 顺序）
  const order = LEVEL_LIST.slice().reverse()
  const seen = [...data.levels.keys()]
  assert.equal(seen.length, new Set(seen).size)
  for (let i = 1; i < seen.length; i++) {
    assert.ok(order.indexOf(seen[i - 1]) < order.indexOf(seen[i]), `等级序错乱：${seen.join(',')}`)
  }
})

test('非舞分支：每曲 4 槽，白谱（level_index 4）被忽略', (t) => {
  if (!ready) return t.skip('曲库未就绪')
  const ids = mai.totalPlateIdList['真']
  const sid = ids.find(id => mai.totalList.byId(id))
  const song = mai.totalList.byId(sid)
  const data = call({
    version: '真', versionName: '真', isWu: false, page: 1, plan: '将',
    playResult: [
      { song_id: sid, level_index: 3, level_value: song.difficulties[3].level_value, achievements: 100, fc: null, fs: null },
      { song_id: sid, level_index: 4, level_value: 14, achievements: 100, fc: null, fs: null },
    ],
  })
  const row = [...data.levels.values()].flat().find(r => r.song_id === sid)
  assert.equal(row.results.length, 4)
  assert.equal(row.results[3].achievements, 100)
  assert.equal(row.results.filter(Boolean).length, 1, '白谱不得写入槽位')
})

test('舞分支：总数/白谱数取 舞 与 舞ReMASTER，白谱曲 5 槽', (t) => {
  if (!ready) return t.skip('曲库未就绪')
  const data = call({ version: '舞', isWu: true, versionName: '舞', page: 1, plan: '将', playResult: [] })
  assert.equal(data.totalCount, mai.totalPlateIdList['舞'].length)
  assert.equal(data.remasterCount, mai.totalPlateIdList['舞ReMASTER'].length)
  assert.equal(data.slotCounts.length, 5)
})

test('舞分支：第 1 页 = 13 以上等级，第 2 页 = 13 及以下；两页并集 = 全部等级', (t) => {
  if (!ready) return t.skip('曲库未就绪')
  const base = { version: '舞', isWu: true, versionName: '舞', plan: '将', playResult: [] }
  const p1 = call({ ...base, page: 1 })
  const p2 = call({ ...base, page: 2 })
  assert.equal(p1.displayLevels[0], '15')
  assert.ok(p1.displayLevels.includes('13+'))
  assert.equal(p2.displayLevels[0], '13')
  assert.ok(!p1.displayLevels.includes('13'))
  // 并集与原等级序一致
  assert.deepEqual([...p1.displayLevels, ...p2.displayLevels], [...p1.levels.keys()])
})

test('completedCount：全部槽位达标才计入', (t) => {
  if (!ready) return t.skip('曲库未就绪')
  const ids = mai.totalPlateIdList['真']
  const pick = ids.filter(id => mai.totalList.byId(id)).slice(0, 2)
  const rows = []
  for (const sid of pick) {
    const song = mai.totalList.byId(sid)
    for (let li = 0; li < 4; li++) {
      rows.push({ song_id: sid, level_index: li, level_value: song.difficulties[li].level_value, achievements: 100, fc: null, fs: null })
    }
  }
  const full = call({ version: '真', versionName: '真', isWu: false, page: 1, plan: '将', playResult: rows })
  assert.equal(full.completedCount, 2)
  assert.equal(full.slotCounts[0], 2)

  // 去掉其中一首的一个槽位 → 该曲不再计入 completed，但另一首仍计入
  const partial = call({
    version: '真', versionName: '真', isWu: false, page: 1, plan: '将',
    playResult: rows.filter(r => !(r.song_id === pick[0] && r.level_index === 1)),
  })
  assert.equal(partial.completedCount, 1)
})
