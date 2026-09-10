import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { mai } from '../lib/service.js'
import { MaiRand, MaiRandSay, parseRandArgs, filterRandSongs } from '../apps/fun.js'

// 宿主全局 logger 打桩（service 模块顶层捕获 global.logger）
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) {
      if (p in console) return console[p].bind(console)
      return (...a) => a.join(' ')
    },
  })
}

/** 造曲：difficulties 的 level 决定颜色位次是否命中 */
function song(song_id, type, levels) {
  return {
    song_id,
    type,
    song_name: `S${song_id}`,
    difficulties: levels.map((lv, i) => ({ level_index: i, level: lv, level_value: Number(lv) })),
  }
}

const SONGS = [
  song(1, 'DX', ['7', '9', '12', '14', '14.5']), // 紫14 命中（index 3），白14.5 命中（index 4）
  song(2, 'SD', ['7', '9', '12', '14']), // 紫14 命中；无白谱
  song(3, 'DX', ['7', '9', '12', '13+', '14']), // 白14 命中，紫13+ 不命中
  song(4, 'DX', ['7', '9', '12', '14', '14']), // 白14 命中
  song(5, 'SD', ['7', '9', '12', '13']), // 紫14 不命中
]

const realList = mai.totalList
/**
 * 桩：复刻 MusicList.filter 的契约
 * （任一难度命中 level 即入选；**level 省略即不限**——全曲库随机正依赖这一点；type 精确匹配）
 */
mai.totalList = {
  filter({ level, type }) {
    return SONGS.filter(s => type.includes(s.type)
      && (!level || s.difficulties.some(d => d.level === level)))
  },
}
after(() => { mai.totalList = realList })

const ids = raw => (filterRandSongs(raw) || []).map(s => s.song_id)

test('parseRandArgs：类型/颜色/定数三段', () => {
  assert.deepEqual(parseRandArgs('dx紫14'), { types: ['DX'], color: '紫', level: '14' })
  assert.deepEqual(parseRandArgs('sd红13'), { types: ['SD'], color: '红', level: '13' })
  assert.deepEqual(parseRandArgs('标准绿7'), { types: ['SD'], color: '绿', level: '7' })
  assert.deepEqual(parseRandArgs('13'), { types: ['SD', 'DX'], color: '', level: '13' })
  assert.deepEqual(parseRandArgs('14+'), { types: ['SD', 'DX'], color: '', level: '14+' })
  assert.deepEqual(parseRandArgs('白14'), { types: ['SD', 'DX'], color: '白', level: '14' })
})

test('parseRandArgs：三段都可省，全空即默认值（对齐帮助里的 [类型][颜色][定数]）', () => {
  const bare = { types: ['SD', 'DX'], color: '', level: '' }
  for (const raw of ['', '   ', null, undefined]) {
    assert.deepEqual(parseRandArgs(raw), bare, `应接受空条件：${JSON.stringify(raw)}`)
  }
  assert.deepEqual(parseRandArgs('dx'), { types: ['DX'], color: '', level: '' }, '只给类型')
  assert.deepEqual(parseRandArgs('紫'), { types: ['SD', 'DX'], color: '紫', level: '' }, '只给颜色')
  assert.deepEqual(parseRandArgs('dx紫'), { types: ['DX'], color: '紫', level: '' }, '类型+颜色')
})

test('parseRandArgs：大小写不敏感（源 re.IGNORECASE），判型时统一小写', () => {
  assert.deepEqual(parseRandArgs('DX紫14'), parseRandArgs('dx紫14'))
  assert.deepEqual(parseRandArgs('SD14'), parseRandArgs('sd14'))
})

test('parseRandArgs：含无法识别字符一律 null（回用法提示）', () => {
  for (const bad of ['abc', 'dx 14', '紫dx14', '14x', 'dx紫14x', '绿黄', '13+14']) {
    assert.equal(parseRandArgs(bad), null, `应判无效：${JSON.stringify(bad)}`)
  }
})

test('filterRandSongs：无参 ⇒ 全曲库随机（phi 的 rand 无参语义）', () => {
  for (const raw of ['', '   ', null, undefined]) {
    assert.equal(filterRandSongs(raw).length, SONGS.length, `空条件应返回全库：${JSON.stringify(raw)}`)
  }
})

test('filterRandSongs：只给类型/颜色时定数不限', () => {
  assert.deepEqual(ids('dx').sort(), [1, 3, 4], '只给类型应为该类型全部曲')
  assert.deepEqual(ids('sd').sort(), [2, 5])
  // 颜色缺定数时退化为「该难度位次存在」：曲 2/5 无 index4，故白只到 1/3/4
  assert.deepEqual(ids('白').sort(), [1, 3, 4])
  assert.deepEqual(ids('dx白').sort(), [1, 3, 4])
})

test('filterRandSongs：无颜色时只按类型+定数筛（保留全部难度）', () => {
  assert.deepEqual(ids('14').sort(), [1, 2, 3, 4])
  assert.deepEqual(ids('dx14').sort(), [1, 3, 4], 'dx 应排除 SD 曲')
  assert.deepEqual(ids('sd14').sort(), [2])
})

test('filterRandSongs：颜色按位次核对该难度定数（绿黄红紫白 → 0..4）', () => {
  // 紫=index3：曲 3 该位是 '13+'、曲 5 是 '13'，均落选
  assert.deepEqual(ids('紫14').sort(), [1, 2, 4])
  assert.deepEqual(ids('dx紫14').sort(), [1, 4], 'dx 再滤掉 SD 的曲 2')
  assert.deepEqual(ids('白14').sort(), [3, 4], '白=index4；曲 1 该位是 14.5 故落选')
})

test('filterRandSongs：难度数不足时不越界（源 len>ci 守卫）', () => {
  // 曲 2/5 只有 4 个难度（无白谱），查白应被排除而不是抛 IndexError
  assert.deepEqual(ids('白14'), [3, 4])
  assert.deepEqual(ids('白13'), [], '没有任何曲的 index4 是 13')
})

test('filterRandSongs：有效条件但无命中 → 空数组；无效条件 → null', () => {
  assert.deepEqual(filterRandSongs('紫15'), [], '无命中应是空数组（调用方回「没有这样的乐曲哦。」）')
  assert.equal(filterRandSongs('abc'), null, '不可解析应是 null（调用方回用法提示）')
})

test('规则：MaiRand 命中 `rand` / `随机`，不收他人命令', () => {
  const reg = new RegExp(new MaiRand().rule[0].reg)
  for (const msg of ['#mai rand', '#mai rand dx紫14', '/mai rand 白13+', '#mai 随机 13', '#mai rand  ']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['#mai random', '#maix rand', 'mai rand', '#phi rand', '#mai 随机播放']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('规则：口语 MaiRandSay 命中「随/来/给个」，无定数不吃', () => {
  const reg = new RegExp(new MaiRandSay().rule[0].reg)
  for (const msg of ['来个13', '随个dx14+', '给个白13', '来个13 谢谢', '随个标准14']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['来个', '来首歌', '来个歌13', '给我个13', '随个abc']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('口语规则：口语头带参数与子命令解析同源（同一 filterRandSongs）', () => {
  const reg = new RegExp(new MaiRandSay().rule[0].reg)
  const m = '给个白13'.match(reg)
  assert.ok(m, '应命中')
  // randSay 把三个捕获组按「类型+颜色+定数」拼回后交给同一个解析器
  assert.deepEqual(filterRandSongs(`${m[1] || ''}${m[2] || ''}${m[3] || ''}`), [])
})
