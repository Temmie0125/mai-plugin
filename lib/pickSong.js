/**
 * 多候选选曲上下文（设计 §3.4：命中多曲 → 发序号列表 → setContext 等下一条消息选号）
 * 替代源「列出相似曲目请用 id 查询」的两步流程；基于宿主上下文机制（用户级隔离，
 * plugin.js:100-178），等待登记不落内存 pending map，超时由宿主兜底提示。
 *
 * 用法：命令类需实现同名上下文方法（宿主 ctx 范式：无参，当前消息读 this.e——
 * loader.js:246 把 setContext 时的旧事件当方法实参传入，切勿再从参数解析消息）：
 *   async pickSong() { return handlePickSong(this) }
 * 发起：awaitPickSong(this, e, songs, async (song) => { ... })
 */

const TTL_MS = 10 * 60 * 1000

/** @type {Map<string, {list: Array, fnc: Function, at: number}>} */
const pendings = new Map()

function keyOf(e) {
  return `${e.self_id}:${e.user_id}`
}

/**
 * 发起选曲等待（this = 命令类实例；60s 超时）
 * @param {object} that plugin 实例（需已实现 pickSong 方法）
 * @param {object} e 事件
 * @param {Array} songs 候选 Song[]
 * @param {Function} fnc async (song, e) => void 选中后执行
 */
export function awaitPickSong(that, e, songs, fnc, { time = 60 } = {}) {
  pendings.set(keyOf(e), { list: songs, fnc, at: Date.now() })
  that.setContext('pickSong', false, time, '选曲超时已取消，可直接重新发起查询')
  const lines = songs.map((s, i) => `${i + 1}. 「${s.song_id}」${s.song_name}`)
  e.reply([
    `找到 ${songs.length} 个相同别名的曲目，请直接回复序号选择：`,
    ...lines,
  ].join('\n'), true)
}

/**
 * 上下文路由处理（命令类 pickSong 方法内调用）
 * 返回 'continue' 放行（用户发的是别的指令）；其余返回值消费本条消息。
 */
export async function handlePickSong(that) {
  const e = that.e // 当前消息（宿主 ctx 范式，勿用方法参数）
  const key = keyOf(e)
  const pending = pendings.get(key)
  if (!pending || Date.now() - pending.at > TTL_MS) {
    pendings.delete(key)
    that.finish('pickSong')
    return 'continue'
  }

  const text = (e.msg || '').trim()
  // 用户改发其他指令：释放上下文放行，不打断
  if (/^[#/]/.test(text)) {
    pendings.delete(key)
    that.finish('pickSong')
    return 'continue'
  }

  const n = parseInt(text, 10)
  if (!Number.isInteger(n) || n < 1 || n > pending.list.length) {
    e.reply('请回复列表中的序号数字，或发送其他指令取消选择', true)
    return false
  }

  const song = pending.list[n - 1]
  pendings.delete(key)
  that.finish('pickSong')
  await pending.fnc(song, e)
  return true
}

/** 按曲名/别名/id 解析（源 mai_score.py info 查找链 + §3.4 多候选升级）
 * @returns {{song: object}|{multi: Array}|null}
 */
export function findSongCandidates(query, maiService) {
  if (/^\d+$/.test(query)) {
    const byId = maiService.totalList.byId(parseInt(query, 10))
    if (byId) return { song: byId }
  }
  const byName = maiService.totalList.byName(query)
  if (byName) return { song: byName }

  const aliases = maiService.totalAliasList.byAlias(query)
  if (aliases.length === 0) return null
  if (aliases.length > 1) return { multi: aliases }
  const song = maiService.totalList.byId(aliases[0].song_id)
  return song ? { song } : null
}
