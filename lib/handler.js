/**
 * 编排层（源 core/handler.py P1 函数子集直译，设计 §5.4）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * P1 范围：getBest50 / drawBest50 / drawPlayData / getMaiWhat / drawChartInfo /
 *          drawSongGlobalData / drawSongList / getRows。
 * 差异：源返回 PIL 图 + MessageSegment，此处返回「回复载荷」——
 *   Buffer | string(错误文案) | [Buffer, string](图 + 附言)，经 picmodle.toSegment 包装发送。
 */
import { mai } from './service.js'
import { DivingFishAPI } from './client/divingfish.js'
import { LxnsAPI, OAuth2 } from './client/lxns.js'
import { MusicNotPlayError } from './client/errors.js'
import * as database from './database.js'
import { effectiveService } from './user.js'
import { Player, serviceDisplay } from './merge/models.js'
import { dfToBest50, dfToPlayer, lxnsToBest50 } from './merge/player.js'
import { dfToPlayresult, lxnsToPlayresult } from './merge/playResult.js'
import { handleErrors } from './handlerError.js'
import {
  b50View, playDataView, chartInfoView, chartInfoBanquetView,
  songListView, songListPaging, globalDataView,
} from './render/views.js'
import {
  renderBest50, renderPlayData, renderChartInfo, renderSongList, renderGlobalData, botName,
} from './render/picmodle.js'

/** 源 handler.py MESSAGE（图后附言） */
export const MESSAGE = '可使用「#mai theme」指令更换主题，「#mai source」指令更换指定查分器。'

/** openid 环境（官方 QQBot 无 QQ 号）下水鱼按 QQ 代查不可用时的引导文案 */
export const DF_QQ_HINT =
  '水鱼查分器需要 QQ 号进行绑定与代查（当前官方QQBot 环境仅提供 openid）。\n' +
  '※ 发送「#mai bind qq <你的QQ号>」补充游戏 QQ 后可解锁水鱼功能；\n' +
  '也可使用「#mai b50 <水鱼用户名>」以用户名查询，或发送「#mai bind lxns」切换落雪数据源。'

/** user 行内是否可作水鱼 QQ 凭据（纯数字 QQ 环境） */
function hasNumericQq(user) {
  return Number.isInteger(user?.qqid) && user.qqid > 0
}

export function getRows(count, rowSize) {
  if (count === 0) return 0
  return Math.floor((count + rowSize - 1) / rowSize)
}

// =====================================================================
// 绑定编排（源 handler.py bind_lxns / bind_divingfish 直译）
// ⚠️ 不包 handleErrors：异常由命令层按绑定场景两档文案分类（查询期文案表不适用）
// =====================================================================

/** 完成落雪绑定：授权码换 token → oauth 取 friend_code → 整体落库（源 bind_lxns + 优化） */
export async function bindLxns(user, code) {
  const oauth = new OAuth2()
  const token = await oauth.fetchToken(code)
  // userId=null 防 oauth 401 刷新路径把未完成绑定写进库（lxns.js 守卫语义）
  const api = new LxnsAPI(null, token)
  const player = await api.player()
  // 用户键 = user.key（openid 或数字 QQ 原样），勿当数字处理
  database.updateUser(user.key ?? user.qqid, {
    friendCode: player.friend_code,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    // 优化（源插件没有）：绑定完成自动切到该数据源——新用户默认在水鱼源，
    // 不自动切会第一次查分落在未绑定的水鱼上
    service: 'lxns',
  })
  return '授权完成。'
}

/** 发起水鱼绑定（服务端 on-behalf；返回 device_authorization 响应供命令层组链接文案） */
export async function bindDivingfish(qqid) {
  const { DivingFishOAuth } = await import('./client/divingfishOauth.js')
  return await new DivingFishOAuth().deviceAuthorization(qqid)
}

/** 用户落雪凭据（源 get_token） */
export function getToken(user) {
  return { access_token: user.accessToken ?? null, refresh_token: user.refreshToken ?? null }
}

/** 获取玩家 B50（源 get_best50：username 显式水鱼用户名流 / service 指针流） */
export async function getBest50(user, { username = null, allPerfect = false } = {}) {
  if (username || effectiveService(user) !== 'lxns') {
    // openid 环境无 QQ 号：仅 username 显式流可用；service=df 且无 QQ → 引导（drawBest50 先兜）
    if (!username && !hasNumericQq(user)) return { dfHint: DF_QQ_HINT }
    const api = new DivingFishAPI(user.qqid, username || null)
    const userinfo = await api.queryUserB50()
    return [dfToPlayer(userinfo), dfToBest50(userinfo)]
  }
  const token = getToken(user)
  const api = new LxnsAPI(user.key ?? String(user.qqid ?? ''), token)
  const player = Player(await api.player())
  const obj = allPerfect
    ? await api.ap50(player.friend_code)
    : await api.best50()
  return [player, lxnsToBest50(obj, mai.totalLevelValueMap)]
}

/** 绘制 B50 / AP50（源 draw_best50） */
export async function drawBest50(user, { username = null, allPerfect = false } = {}) {
  return handleErrors(async () => {
    const [player, best50] = await getBest50(user, { username, allPerfect })
    if (best50?.dfHint) return best50.dfHint
    const isUsername = Boolean(username)
    const view = b50View({
      theme: isUsername ? 'prism_plus' : (user.theme || 'prism_plus'),
      qqid: isUsername ? null : Number(user.qqid),
      player,
      best50,
      serviceName: serviceDisplay(isUsername ? 'df' : effectiveService(user)),
      botName: botName(),
    })
    const image = await renderBest50(view)
    if (typeof image === 'string') return image
    return [image, MESSAGE]
  })
}

/** 绘制单曲游玩成绩（源 draw_play_data） */
export async function drawPlayData(user, song) {
  return handleErrors(async () => {
    let playResult
    if (effectiveService(user) !== 'lxns') {
      if (!hasNumericQq(user)) return DF_QQ_HINT
      const api = new DivingFishAPI(user.qqid)
      const data = await api.queryUserRecord(song.song_id)
      if (!data || data.length === 0) throw new MusicNotPlayError()
      playResult = dfToPlayresult(data, song)
    } else {
      const token = getToken(user)
      const api = new LxnsAPI(user.key ?? String(user.qqid ?? ''), token)
      let songType
      if (song.song_id < 10000) songType = 'standard'
      else if (song.song_id < 100000) songType = 'dx'
      else songType = 'utage'
      const data = await api.songBests(song.song_id % 10000, songType)
      if (!data || data.length === 0) throw new MusicNotPlayError()
      playResult = lxnsToPlayresult(data, song, mai.totalLevelValueMap)
    }

    const view = playDataView({
      theme: user.theme || 'prism_plus',
      song,
      playResult,
      serviceName: serviceDisplay(effectiveService(user)),
      botName: botName(),
    })
    const image = await renderPlayData(view)
    if (typeof image === 'string') return image
    return [image, MESSAGE]
  })
}

/** 随机推分曲目（源 get_mai_what：按 B35/B15 末位 rating 随段推荐） */
export async function getMaiWhat(user) {
  return handleErrors(async () => {
    const result = await getBest50(user)
    if (!Array.isArray(result)) return null // openid+df 无 QQ → 无推荐可给，静默
    const [, best50] = result
    const r = Math.floor(Math.random() * 2)
    let ra = 0
    let ignore = []
    if (r === 0) {
      if (best50.sd.length) {
        ignore = best50.sd.filter(m => m.achievements < 100.5).map(m => m.song_id)
        ra = best50.sd[best50.sd.length - 1].rating
      }
    } else if (best50.dx.length) {
      ignore = best50.dx.filter(m => m.achievements < 100.5).map(m => m.song_id)
      ra = best50.dx[best50.dx.length - 1].rating
    }
    if (ra !== 0) {
      const ds = Math.round((ra / 22.4) * 10) / 10
      let musicList = mai.totalList.filter({ level_value: [ds, ds + 1] })
      musicList = musicList.filter(m => !ignore.includes(m.song_id))
      if (!musicList.length) return null
      return musicList[Math.floor(Math.random() * musicList.length)]
    }
    return null
  })
}

/** 绘制谱面信息卡（源 draw_chart_info：含用户 B50 拟合上涨计算；宴谱走专用卡） */
export async function drawChartInfo(song, user = null) {
  return handleErrors(async () => {
    if (song.song_id < 100000) {
      let calc = false
      let isFull = false
      let bestList = []
      let theme
      if (user != null) {
        theme = user.theme
        try {
          let best50
          if (effectiveService(user) !== 'lxns') {
            const api = new DivingFishAPI(user.qqid)
            const userinfo = await api.queryUserB50()
            best50 = dfToBest50(userinfo)
          } else {
            const api = new LxnsAPI(user.key ?? String(user.qqid ?? ''), getToken(user))
            best50 = lxnsToBest50(await api.best50(), mai.totalLevelValueMap)
          }
          calc = true
          if (song.isnew) {
            bestList = best50.dx
            isFull = bestList.length === 15
          } else {
            bestList = best50.sd
            isFull = bestList.length === 35
          }
        } catch {
          calc = false
        }
      } else {
        theme = 'prism_plus'
      }
      const view = chartInfoView({ song, calc, isFull, bestList, theme, botName: botName() })
      const image = await renderChartInfo(view)
      if (typeof image === 'string') return image
      return [image, MESSAGE]
    }

    const view = chartInfoBanquetView({ song, botName: botName() })
    const image = await renderChartInfo(view)
    if (typeof image === 'string') return image
    return [image, MESSAGE]
  })
}

/** 全服统计饼图 + 统计文本（源 draw_song_global_data + mai_score.py ginfo 附言） */
export async function drawSongGlobalData(song, levelIndex) {
  return handleErrors(async () => {
    const view = globalDataView({ song, levelIndex })
    const image = await renderGlobalData(view)
    if (typeof image === 'string') return image
    return [image, view.text]
  })
}

// =====================================================================
// RA 排行（源 handler.py draw_rating_ranking + mai_base.py my_rating_ranking 直译）
// 列表页源走 text→PNG，本插件按 §6.4 文本规范改宿主合并转发/分段（apps 层决定载体）
// =====================================================================

export function fmtRankTime(date = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

/** 拉取 df 全服 RA 排行（已按 ra 降序） */
export async function getRatingRanking() {
  const api = new DivingFishAPI()
  const rows = await api.ratingRanking()
  return { time: fmtRankTime(), rows }
}

/** 用户名精确名次文本（源 name 分支；lowercase 匹配全表） */
export function rankNameText({ rows, time, name }) {
  const found = rows.findIndex(r => r.username.toLowerCase() === String(name).toLowerCase())
  if (found >= 0) {
    return `截止至「${time}」玩家「${rows[found].username}」\n` +
      `在查分器已注册用户 RA 排行第「${found + 1}」位`
  }
  return `未在查分器排行榜前「${rows.length}」名中找到玩家「${name}」`
}

/** 列表页文本与分页元信息（源 per_page=50 / clamp / No.%02d / 页脚） */
export function rankListText({ rows, time, page = 1 }) {
  const perPage = 50
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage))
  const p = Math.max(1, Math.min(page, totalPages))
  const start = (p - 1) * perPage
  const slice = rows.slice(start, start + perPage)
  const header = `截止至「${time}」，查分器已注册用户 RA 排行：\n`
  const lines = slice.map((r, i) => `No.${String(start + i + 1).padStart(2, '0')}.「${r.ra}」 ${r.username}`)
  const footer = `\n第「${p} / ${totalPages}」页，共「${rows.length}」名玩家`
  return { text: header + lines.join('\n') + footer, page: p, totalPages, perPage }
}

/** 我的排名（源 mai_base my_rating_ranking：/query/player 取 username → 全表精确等值匹配） */
export async function myRatingRankingText(qqid) {
  if (!Number.isInteger(qqid) || qqid <= 0) return DF_QQ_HINT
  const api = new DivingFishAPI(qqid)
  const userinfo = await api.queryUserB50()
  const username = userinfo.username
  const { time, rows } = await getRatingRanking()
  const idx = rows.findIndex(r => r.username === username)
  if (idx < 0) return '未在查分器排行榜中找到您的记录。'
  return `您的Rating为「${rows[idx].ra}」，排名第「${idx + 1}」名`
}

/** 绘制曲目列表（源 draw_song_list：14 曲/页，2 列卡片） */
export async function drawSongList(songs, page = 1) {
  return handleErrors(async () => {
    const { page: p, totalPage, slice } = songListPaging(songs.length, page)
    const view = songListView({
      songs: songs.slice(slice[0], slice[1]),
      page: p,
      totalPage,
      botName: botName(),
    })
    return await renderSongList(view)
  })
}
