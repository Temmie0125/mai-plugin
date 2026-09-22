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
 * （任一难度命中 level 即入选；**level 省略即不限**——全曲库随机正依赖这一点；type 精确匹配；
 * level_value 单值为精确、二元组为闭区间，NaN 级（13+ 字面造不出数值）自然落选）
 */
mai.totalList = {
  filter({ level, level_value: lv, type }) {
    return SONGS.filter(s => type.includes(s.type)
      && (!level || s.difficulties.some(d => d.level === level))
      && (lv == null || s.difficulties.some(d => Array.isArray(lv)
        ? lv[0] <= d.level_value && d.level_value <= lv[1]
        : d.level_value === lv)))
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

test('parseRandArgs：小数定数与区间（本仓三态扩展）', () => {
  assert.deepEqual(parseRandArgs('14.9'), { types: ['SD', 'DX'], color: '', level: '14.9' }, '小数 → 定数值精确')
  assert.deepEqual(parseRandArgs('dx紫14.5'), { types: ['DX'], color: '紫', level: '14.5' })
  assert.deepEqual(parseRandArgs('13-14'), { types: ['SD', 'DX'], color: '', level: '13-14' }, '区间 → 定数值区间')
  assert.deepEqual(parseRandArgs('13 - 14'), { types: ['SD', 'DX'], color: '', level: '13 - 14' }, '连接符两侧空格可选')
  assert.deepEqual(parseRandArgs('13.5~15'), { types: ['SD', 'DX'], color: '', level: '13.5~15' }, '端点可带小数/全角连接符')
  assert.equal(parseRandArgs('13.5+'), null, '小数不接 +')
  assert.equal(parseRandArgs('13-14-15'), null, '双连接符非法')
  assert.equal(parseRandArgs('-13'), null, '缺左端点非法')
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

test('filterRandSongs：小数定数按 level_value 精确匹配', () => {
  // 夹具：曲 1 的白谱（index4）定数 14.5
  assert.deepEqual(ids('14.5'), [1])
  assert.deepEqual(ids('白14.5'), [1], '颜色按位次核对定数值')
  assert.deepEqual(ids('紫14.5'), [], '曲 1 的 14.5 在白位不在紫位（紫位是 14）')
  assert.deepEqual(ids('14.9'), [], '无命中 → 空数组（回「没有这样的乐曲哦。」）')
  assert.deepEqual(ids('dx14.5'), [1], '小数与类型叠加')
})

test('filterRandSongs：定数区间按 level_value 过滤（与检索族「定数13-14」同口径）', () => {
  // 五曲各有一张 [13,14] 内的谱（13 或 14）；曲 1 的 14.5 在区间外但其 14 在内
  assert.deepEqual(ids('13-14').sort(), [1, 2, 3, 4, 5])
  assert.deepEqual(ids('14.5-15'), [1], '只有曲 1 有 ≥14.5 的谱')
  assert.deepEqual(ids('白13-15').sort(), [1, 3, 4], '区间+颜色：位次定数值须落在区间内（曲 2/5 无白谱）')
  assert.deepEqual(ids('13~14'), ids('13-14'), '波浪连接符等价')
  assert.deepEqual(ids('紫13.5-13.9'), [], '区间端点带小数照常工作（夹具紫位无此区间值）')
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
  for (const msg of ['来个13', '随个dx14+', '给个白13', '来个13 谢谢', '随个标准14', '随个14.9', '随个13-14']) {
    assert.match(msg, reg, `应命中：${msg}`)
  }
  for (const msg of ['来个', '来首歌', '来个歌13', '给我个13', '随个abc']) {
    assert.doesNotMatch(msg, reg, `不应命中：${msg}`)
  }
})

test('口语规则：定数捕获完整（尾段通配不得吃掉末位/小数/区间）', () => {
  const reg = new RegExp(new MaiRandSay().rule[0].reg)
  const levelOf = msg => msg.match(reg)?.[3]
  // 源正则末尾强制通配 `.` 会把末位吃给尾段：`随个13` 实解析成定数 1、`随个14.9` 解析成 14
  assert.equal(levelOf('随个13'), '13')
  assert.equal(levelOf('随个14.9'), '14.9')
  assert.equal(levelOf('随个13-14'), '13-14')
  assert.equal(levelOf('随个13 - 14'), '13 - 14')
  assert.equal(levelOf('给个白13'), '13')
  assert.equal(levelOf('随个dx14+'), '14+')
  assert.equal(levelOf('来个13 谢谢'), '13')
})

test('口语规则：口语头带参数与子命令解析同源（同一 filterRandSongs）', () => {
  const reg = new RegExp(new MaiRandSay().rule[0].reg)
  const m = '给个白13'.match(reg)
  assert.ok(m, '应命中')
  // randSay 把三个捕获组按「类型+颜色+定数」拼回后交给同一个解析器
  assert.deepEqual(filterRandSongs(`${m[1] || ''}${m[2] || ''}${m[3] || ''}`), [])
})
