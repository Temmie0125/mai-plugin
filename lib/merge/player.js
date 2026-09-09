/**
 * 玩家/B50 转换（源 core/merge/player.py 直译）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 */
import { Best50, PlayedResult, Player, Collection } from './models.js'
import { lxnsFormatResult } from './playResult.js'

export function lxnsPlayList(scores, levelValueMap = {}) {
  return scores.map(v => lxnsFormatResult(v, levelValueMap))
}

export function lxnsToBest50(best50, levelValueMap = {}) {
  return Best50({
    sd_total: best50.standard_total,
    dx_total: best50.dx_total,
    sd: lxnsPlayList(best50.standard ?? [], levelValueMap),
    dx: lxnsPlayList(best50.dx ?? [], levelValueMap),
  })
}

export function dfToPlayer(userinfo) {
  return Player({
    name: userinfo.nickname ?? '',
    rating: userinfo.rating ?? 0,
    course_rank: userinfo.additional_rating ?? 0,
    name_plate: userinfo.plate ?? null,
  })
}

function dfTotalPlayList(chart) {
  let total = 0
  const playList = []
  for (const v of chart ?? []) {
    total += v.ra
    playList.push(PlayedResult({
      song_id: v.song_id ?? v.id,
      song_name: v.title,
      level: v.level,
      level_value: v.ds ?? 0,
      level_index: v.level_index,
      type: v.type,
      rating: v.ra,
      achievements: v.achievements,
      fc: v.fc || null,
      fs: v.fs || null,
      rate: v.rate || null,
      dx_score: v.dxScore ?? 0,
      level_label: v.level_label ?? null,
    }))
  }
  return [total, playList]
}

export function dfToBest50(userinfo) {
  const [sdTotal, sdPlayList] = dfTotalPlayList(userinfo.charts?.sd)
  const [dxTotal, dxPlayList] = dfTotalPlayList(userinfo.charts?.dx)
  return Best50({ sd_total: sdTotal, dx_total: dxTotal, sd: sdPlayList, dx: dxPlayList })
}
