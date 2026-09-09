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
import { LxnsAPI } from './client/lxns.js'
import { MusicNotPlayError } from './client/errors.js'
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
export const MESSAGE = '可使用「主题」指令更换主题，「数据源」指令更换指定查分器。'

export function getRows(count, rowSize) {
  if (count === 0) return 0
  return Math.floor((count + rowSize - 1) / rowSize)
}

/** 用户落雪凭据（源 get_token） */
export function getToken(user) {
  return { access_token: user.accessToken ?? null, refresh_token: user.refreshToken ?? null }
}

/** 获取玩家 B50（源 get_best50：username 显式水鱼用户名流 / service 指针流） */
export async function getBest50(user, { username = null, allPerfect = false } = {}) {
  if (username || user.service !== 'lxns') {
    const api = new DivingFishAPI(user.qqid, username || null)
    const userinfo = await api.queryUserB50()
    return [dfToPlayer(userinfo), dfToBest50(userinfo)]
  }
  const token = getToken(user)
  const api = new LxnsAPI(String(user.qqid), token)
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
    const isUsername = Boolean(username)
    const view = b50View({
      theme: isUsername ? 'prism_plus' : (user.theme || 'prism_plus'),
      qqid: isUsername ? null : Number(user.qqid),
      player,
      best50,
      serviceName: serviceDisplay(isUsername ? 'df' : user.service),
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
    if (user.service !== 'lxns') {
      const api = new DivingFishAPI(user.qqid)
      const data = await api.queryUserRecord(song.song_id)
      if (!data || data.length === 0) throw new MusicNotPlayError()
      playResult = dfToPlayresult(data, song)
    } else {
      const token = getToken(user)
      const api = new LxnsAPI(String(user.qqid), token)
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
      serviceName: serviceDisplay(user.service),
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
    const [, best50] = await getBest50(user)
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
          if (user.service !== 'lxns') {
            const api = new DivingFishAPI(user.qqid)
            const userinfo = await api.queryUserB50()
            best50 = dfToBest50(userinfo)
          } else {
            const api = new LxnsAPI(String(user.qqid), getToken(user))
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
