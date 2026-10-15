/**
 * 多候选选曲单测（设计 §3.4）：
 * ① `findSongCandidates` 纯函数：别名行**先解析成曲库内曲目再判单/多**——
 *    回归生产实测「#mai fsline 紫后潘」：别名库含曲库不存在的孤儿行（落雪 +10000
 *    盲偏移产生，如 SD-only 曲 AFTER PANDORA 被偏移出 11819），按行数判定会把
 *    唯一命中撑成「找到 1 个相同别名的曲目」的选择列表；
 * ② 命令路径：唯一命中直接出图，不弹选曲（apps/global.js:fsline）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// apps/global.js 会沿 import 链触达 Yunzai 宿主与 logger，动态导入前先垫（同 tests/fsline.test.js）
if (!global.logger) {
  const base = console.log.bind(console)
  global.logger = new Proxy(base, {
    get(t, p) { return p in console ? console[p].bind(console) : (...a) => a.join(' ') },
  })
}

const { findSongCandidates } = await import('../lib/pickSong.js')

/** 最小 maiService 桩：byAlias 大小写不敏感（AliasList.byAlias 同口径） */
function stubService(songs, aliasRows) {
  const byId = id => songs.find(s => s.song_id === id) ?? null
  return {
    totalList: {
      byId,
      byName: name => songs.find(s => s.song_name === name) ?? null,
    },
    totalAliasList: {
      byAlias: q => aliasRows.filter(r => r.alias.some(a => a.toLowerCase() === String(q).toLowerCase())),
    },
  }
}

test('回归：唯一命中但别名行含曲库孤儿行 → 直接返回单曲，不进多选', () => {
  // 生产实测形态：柚子/落雪都把「后潘」挂在 1819，落雪行被旧合并盲偏移出孤儿 11819
  const mai = stubService(
    [{ song_id: 1819, song_name: 'AFTER PANDORA' }],
    [
      { song_id: 1819, alias: ['after pandora', '后潘'] },
      { song_id: 11819, alias: ['后潘', '潘多拉之后'] }, // 孤儿：曲库无 11819
    ],
  )
  const found = findSongCandidates('后潘', mai)
  assert.equal(found.multi, undefined, '唯一命中不得返回 multi')
  assert.equal(found.song.song_id, 1819)
})

test('真多候选：解析后 ≥2 首才进多选，元素是曲库曲目（调用方无需再 byId）', () => {
  const mai = stubService(
    [
      { song_id: 44, song_name: 'SD 谱' },
      { song_id: 10044, song_name: 'DX 谱' },
    ],
    [
      { song_id: 44, alias: ['双谱曲'] },
      { song_id: 10044, alias: ['双谱曲'] },
      { song_id: 999999, alias: ['双谱曲'] }, // 孤儿行不计入候选数
    ],
  )
  const found = findSongCandidates('双谱曲', mai)
  assert.deepEqual(found.multi.map(s => s.song_id), [44, 10044])
})

test('别名只挂在孤儿行上 → null（回「未找到曲目」，不再把幽灵行当候选）', () => {
  const mai = stubService(
    [{ song_id: 1819, song_name: 'AFTER PANDORA' }],
    [{ song_id: 11819, alias: ['幽灵别名'] }],
  )
  assert.equal(findSongCandidates('幽灵别名', mai), null)
})

test('id / 精确曲名优先于别名（原查找链顺序不变）', () => {
  const mai = stubService(
    [{ song_id: 799, song_name: 'Sigma' }],
    [{ song_id: 799, alias: ['799'] }],
  )
  assert.equal(findSongCandidates('799', mai).song.song_id, 799, '纯数字走 id 直查')
  assert.equal(findSongCandidates('Sigma', mai).song.song_id, 799, '精确曲名直查')
  assert.equal(findSongCandidates('不存在', mai), null)
})

// ---------------------------------------------------------------------------
// ② 命令路径：唯一命中直接出图（apps/global.js:fsline），不弹「找到 x 个相同别名」
// ---------------------------------------------------------------------------

test('命令路径回归：紫后潘 → 直达 sendFsline；真多候选 → 才弹选择列表', async () => {
  const { MaiGlobal } = await import('../apps/global.js')
  const { mai } = await import('../lib/service.js')

  // 换上确定性桩库（含生产同款孤儿行），退出前还原单例
  const saved = { list: mai.totalList, alias: mai.totalAliasList, ready: mai.ready }
  const stub = stubService(
    [
      { song_id: 1819, song_name: 'AFTER PANDORA', difficulties: [1, 2, 3, 4] },
      { song_id: 44, song_name: 'SD 谱', difficulties: [1, 2, 3, 4] },
      { song_id: 10044, song_name: 'DX 谱', difficulties: [1, 2, 3, 4] },
    ],
    [
      { song_id: 1819, alias: ['后潘'] },
      { song_id: 11819, alias: ['后潘'] }, // 孤儿
      { song_id: 44, alias: ['双谱曲'] },
      { song_id: 10044, alias: ['双谱曲'] },
    ],
  )
  mai.totalList = stub.totalList
  mai.totalAliasList = stub.totalAliasList
  mai.ready = true
  try {
    const inst = new MaiGlobal()
    const replies = []
    // awaitPickSong 走 e.reply、命令层走 this.reply，两处都要接住
    const eReply = msg => { replies.push(String(msg)) }
    inst.reply = async (msg) => { replies.push(String(msg)) }
    inst.setContext = () => {} // 宿主上下文机制不进测试
    const calls = []
    inst.sendFsline = async (song, levelIndex) => { calls.push([song.song_id, levelIndex]) }

    // 回归本体：唯一命中（孤儿行被淘汰）→ 直达出图，无任何选择列表
    await inst.fsline({ msg: '#mai fsline 紫后潘', self_id: 't', user_id: 'u1', reply: eReply })
    assert.deepEqual(calls, [[1819, 3]])
    assert.deepEqual(replies, [], '不得出现「找到 1 个相同别名的曲目」')

    // 真多候选（SD/DX 双谱都在曲库）→ 仍弹选择，列表只含曲库内曲目
    replies.length = 0
    await inst.fsline({ msg: '#mai fsline 紫双谱曲', self_id: 't', user_id: 'u2', reply: eReply })
    assert.deepEqual(calls, [[1819, 3]], '多候选时不出图，等选号')
    assert.equal(replies.length, 1)
    assert.match(replies[0], /找到 2 个相同别名的曲目/)
    assert.match(replies[0], /「44」SD 谱/)
    assert.match(replies[0], /「10044」DX 谱/)
  } finally {
    mai.totalList = saved.list
    mai.totalAliasList = saved.alias
    mai.ready = saved.ready
  }
})
