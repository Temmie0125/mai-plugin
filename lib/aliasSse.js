/**
 * 别名推送 SSE（源 `core/alias_sse_push.py` + `core/alias_ws_push.py`，
 * 设计 §7.2 / P3 实施文档 §8）
 *
 * ⚠️ **源侧这条链路是空操作，不能照搬**（实施文档 §8.1 已论证）：
 * 事件层先把 `type == "Apply"` 的事件 `continue` 掉，而 `push_alias` 里**只**为 `Apply`
 * 构造消息 ⇒ 源的全局开关为真（其出厂默认）时收到任何事件都既不推送也不刷库；
 * 真正做群发的 `core/alias_ws_push.py` 在源里是**死代码**（从未被 import），且它访问的
 * `status.apply_uid` / `status.group_id` 在 `AliasStatus` 上**不存在**，一旦执行必抛。
 * 故端口按设计意图重写，并登记为刻意偏离：
 * - `Apply` **恢复广播**（源丢弃）；
 * - `Approved` / `Reject` **降级为普通广播、不 @ 申请人**（源依赖那两个不存在的字段）；
 * - 退避用**指数 3→60 秒**（源恒为 3 秒，只有服务端下发 `retry` 时才变——文档 §7.2 说的
 *   「指数退避是源行为」经查证不成立）。
 *
 * 与源的其它差异：源在**数据加载之前**就连（早到事件会撞空库），端口改为数据就绪后启动。
 */
import Config from './config.js'
import * as database from './database.js'
import { mai, rebuildAliasFromCache } from './service.js'
import { YuzuChaNAPI } from './client/yuzuchan.js'
import { drawChartInfo } from './handler.js'
import { toSegment } from './render/picmodle.js'
import { VOTE_URL } from './constants.js'

/**
 * 兜底日志器：**console 上没有 .mark / .warn**，直接 `global.logger || console` 会让
 * 「打一句日志把业务打挂」。本模块尤其容易踩：宿主全局 logger 由测试打桩，
 * 而 ESM 的 import 提升使打桩晚于模块求值，顶层捕获到的一律是 console。
 * 故这里把 console 补齐成同形接口（生产走宿主 logger，行为不变）。
 */
const consoleLogger = {
  mark: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
}
const logger = global.logger || consoleLogger

const SSE_RECONNECT_DELAY = 3
const SSE_RECONNECT_DELAY_MAX = 60
/** 群间发送间隔（源 5 秒；端口取 1.5 秒，避免刷屏又不至于太久） */
const GROUP_SEND_GAP = 1500
/** 本进程已见到的最后一个事件 id（断点续传；进程重启即失，源同） */
let lastEventId = null

// =====================================================================
// 纯解析层（便于单测）
// =====================================================================

/**
 * SSE 帧解析（源 `iter_sse` 直译）
 *
 * 语义逐条照搬：空行**分发**（仅当 data 非空；event/id/retry 无论是否有 data 都重置）、
 * `:` 开头为注释、`field: value` 只剥**一个**前导空格、多行 `data` 以 `\n` 连接、
 * `id` 含 NUL 则忽略、`retry` 仅接受十进制、流结束后冲刷残留缓冲。
 * @param {AsyncIterable<string>} lines 逐行输入（不含换行符）
 */
export async function* parseSse(lines) {
  let event = 'message'
  let data = []
  let id
  let retry

  for await (const line of lines) {
    if (line === '') {
      if (data.length) yield { event, data: data.join('\n'), id, retry }
      event = 'message'
      data = []
      id = undefined
      retry = undefined
      continue
    }
    if (line.startsWith(':')) continue

    const sep = line.indexOf(':')
    const field = sep < 0 ? line : line.slice(0, sep)
    let value = sep < 0 ? '' : line.slice(sep + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id' && !value.includes('\0')) id = value
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value)
  }

  if (data.length) yield { event, data: data.join('\n'), id, retry }
}

/** ReadableStream → 逐行（跨 chunk 的半行要拼起来；兼容 CRLF） */
export async function* readLines(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const strip = s => (s.endsWith('\r') ? s.slice(0, -1) : s)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        yield strip(buf.slice(0, idx))
        buf = buf.slice(idx + 1)
      }
    }
    buf += decoder.decode()
    if (buf) yield strip(buf)
  } finally {
    try { await reader.cancel() } catch { /* 流可能已断开，忽略 */ }
  }
}

/** 服务端下发的 `retry`（毫秒）→ 秒，钳到 [0.1, 60]（源同） */
export function clampRetry(ms) {
  return Math.min(Math.max(Number(ms) / 1000, 0.1), SSE_RECONNECT_DELAY_MAX)
}

/** 下一次退避秒数（指数增长、封顶 60） */
export function nextDelay(current) {
  return Math.min(current * 2, SSE_RECONNECT_DELAY_MAX)
}

// =====================================================================
// 事件处理
// =====================================================================

/** 事件 → 广播文案（源 `alias_ws_push.py:push_alias` 的文案逐字） */
export function eventText(type, item) {
  const song = mai.totalList.byId(item?.song_id)
  const title = item?.name || song?.song_name || ''
  const id = item?.song_id
  const alias = item?.apply_alias ?? ''
  if (type === 'Apply') {
    return '检测到新的别名申请\n=================\n'
      + `${item?.tag}：\nID：${id}\n标题：${title}\n别名：${alias}\n浏览${VOTE_URL}查看详情`
  }
  if (type === 'End') {
    return `检测到新增别名\n=================\nID：${id}\n标题：${title}\n别名：${alias}`
  }
  if (type === 'Approved') {
    return '您申请的别名已通过审核\n=================\n'
      + `${item?.tag}：\nID：${id}\n标题：${title}\n别名：${alias}\n`
      + `=================\n请使用指令「同意别名 ${item?.tag}」进行投票`
  }
  if (type === 'Reject') {
    return `您申请的别名被拒绝\n=================\nID：${id}\n标题：${title}\n别名：${alias}`
  }
  return null
}

/** 别名库刷新：**优先走缓存重建**（不联网），缓存缺失才联网 */
async function refreshAliases() {
  if (rebuildAliasFromCache()) return
  try {
    await mai.getMusicAlias()
  } catch (error) {
    logger.error(`[mai-plugin] 别名推送触发的库刷新失败：${error?.message || error}`)
  }
}

/** 广播到白名单群（文案 + 曲绘卡；单群失败只记日志，不影响其余） */
async function broadcast(text, songId) {
  const groups = database.groupsWithAliasPush()
  if (!groups.length) return 0

  let payload = text
  const song = mai.totalList.byId(songId)
  if (song) {
    const card = await drawChartInfo(song, null)
    if (typeof card !== 'string') payload = toSegment([text, ...(Array.isArray(card) ? card : [card])])
  }

  let sent = 0
  for (const gid of groups) {
    try {
      await globalThis.Bot?.pickGroup?.(gid)?.sendMsg?.(payload)
      sent++
    } catch (error) {
      logger.error(`[mai-plugin] 别名推送到群 ${gid} 失败：${error?.message || error}`)
    }
    await new Promise(r => setTimeout(r, GROUP_SEND_GAP))
  }
  return sent
}

/**
 * 处理一条别名事件：**任何事件都先刷库**（别名变更即信号），再按类型广播
 * @returns {Promise<boolean>} 是否产生了广播
 */
export async function handleAliasEvent(raw) {
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    logger.warn('[mai-plugin] 收到无法解析的别名推送事件，已忽略')
    return false
  }

  await refreshAliases()

  const type = payload?.type
  const status = Array.isArray(payload?.status) ? payload.status : []
  let sent = 0
  for (const item of status) {
    const text = eventText(type, item)
    if (!text) continue
    sent += await broadcast(text, item?.song_id)
  }
  return sent > 0
}

// =====================================================================
// 连接循环
// =====================================================================

/** 模块级单例：宿主热更会重建模块，故用 `started` 守卫避免重复连接 */
let started = false
let running = false
let controller = null

/** 建连条件：总开关开 **且** 白名单非空（都满足才值得维持这条第三方长连接） */
export function shouldConnect() {
  return Boolean(Config.getUserCfg('config', 'aliasPush')) && database.groupsWithAliasPush().length > 0
}

export function isRunning() {
  return started
}

/** 同步断开（`process.on('exit')` 只能用同步操作） */
export function shutdown() {
  running = false
  started = false
  try { controller?.abort() } catch { /* 已断开 */ }
  controller = null
}

async function sleep(seconds) {
  await new Promise(r => setTimeout(r, seconds * 1000))
}

async function loop() {
  let delay = SSE_RECONNECT_DELAY
  while (running) {
    let connected = false
    controller = new AbortController()
    try {
      const resp = await new YuzuChaNAPI().openEventStream({
        lastEventId,
        signal: controller.signal,
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const ctype = String(resp.headers.get('content-type') || '')
      // 内容类型不符必须断开重连（源同）：否则会把一段 HTML 错误页当成事件流解析
      if (ctype.split(';')[0].trim().toLowerCase() !== 'text/event-stream') {
        throw new Error(`服务器返回了非 SSE 响应：${ctype || 'unknown'}`)
      }

      connected = true
      delay = SSE_RECONNECT_DELAY // 连上即重置退避
      logger.mark('[mai-plugin] 别名推送服务器连接成功')

      for await (const msg of parseSse(readLines(resp.body))) {
        if (!running) break
        if (msg.id !== undefined) lastEventId = msg.id || null
        if (msg.retry != null) delay = clampRetry(msg.retry)
        if (msg.event !== 'alias') continue
        try {
          await handleAliasEvent(msg.data)
        } catch (error) {
          logger.error(`[mai-plugin] 处理别名推送事件失败：${error?.message || error}`)
        }
      }
      if (running) logger.warn('[mai-plugin] 别名推送服务器已断开')
    } catch (error) {
      if (!running) break
      logger.warn(`[mai-plugin] 别名推送连接异常：${error?.message || error}`)
    }

    if (!running) break
    await sleep(delay)
    // 连上过又断开 ⇒ 退避已重置，保持基础间隔；连不上 ⇒ 指数增长
    if (!connected) delay = nextDelay(delay)
  }
}

/** 启用（幂等）：调用方应先判 `shouldConnect()` */
export function start() {
  if (started) return false
  started = true
  running = true
  // 不 await：长连接会一直跑；内部异常自己兜
  loop().catch(error => logger.error(`[mai-plugin] 别名推送循环异常退出：${error?.message || error}`))
  return true
}

/** 停用（幂等） */
export function stop() {
  if (!started) return false
  shutdown()
  logger.mark('[mai-plugin] 别名推送已停用，连接已断开')
  return true
}

/**
 * 重估连接状态（启动时 + 每次 `push` 命令后）
 * 由「不满足→满足」建连、反向断开；管理员切开关是低频操作，不会造成重连抖动。
 */
export function reevaluate() {
  if (shouldConnect()) return start()
  return stop()
}

process.on('exit', shutdown)
