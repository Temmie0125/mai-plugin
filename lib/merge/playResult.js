/**
 * 成绩转换（源 core/merge/play_result.py 直译）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * DF 响应字段（title/dxScore/ra/id）→ 领域 PlayedResult；LXNS Score → 按 type 映射 song_id。
 */
import { NotPlayedResult, PlayedResult, normalizeType, emptyToNull } from './models.js'

export function dfFormatResult(v, levelValue = 0) {
  const ds = levelValue === 0 ? (v.ds ?? 0) : levelValue
  return PlayedResult({
    song_id: v.song_id ?? v.id,
    song_name: v.title,
    level: v.level,
    level_index: v.level_index,
    level_value: ds,
    type: v.type,
    rating: v.ra,
    achievements: v.achievements,
    fc: emptyToNull(v.fc ?? ''),
    fs: emptyToNull(v.fs ?? ''),
    rate: emptyToNull(v.rate ?? ''),
    dx_score: v.dxScore ?? 0,
    level_label: v.level_label ?? null,
  })
}

export function dfToPlayresult(data, song = null) {
  const r = song
    ? song.difficulties.map(d => NotPlayedResult({
        level_value: d.level_value, song_id: song.song_id, level_index: d.level_index,
      }))
    : []
  for (const v of data) {
    if (song) {
      r[v.level_index] = dfFormatResult(v, r[v.level_index]?.level_value ?? 0)
    } else {
      r.push(dfFormatResult(v))
    }
  }
  return r
}

export function lxnsFormatResult(v, levelValueMap = {}) {
  let songId = v.id
  if (v.type === 'standard') songId = v.id
  // ⚠️ 落雪现已统一「标准/DX 同 ID」（新 API 文档：「不存在大于 10000 的曲目 ID」），
  // 故 DX 的 id 仍是 <10000、需 +10000 还原成仓内的 DX song_id；
  // 但旧快照/旧缓存里可能是已带偏移的 id（10001+）—— 加一层判重，两种形态都能还原。
  else if (v.type === 'dx') songId = v.id >= 10000 ? v.id : v.id + 10000
  return PlayedResult({
    song_id: songId,
    song_name: v.song_name,
    level: v.level,
    level_index: v.level_index,
    type: normalizeType(v.type),
    rating: Math.trunc(v.dx_rating ?? 0),
    achievements: v.achievements,
    fc: emptyToNull(v.fc ?? ''),
    fs: emptyToNull(v.fs ?? ''),
    rate: emptyToNull(v.rate ?? ''),
    dx_score: v.dx_score ?? 0,
    dx_star: v.dx_star ?? null,
    upload_time: v.upload_time ?? null,
    level_value: levelValueMap[`${songId}-${v.level_index}`] ?? 0,
  })
}

export function lxnsToPlayresult(data, song = null, levelValueMap = {}) {
  const r = song
    ? song.difficulties.map(d => NotPlayedResult({
        level_value: d.level_value, song_id: song.song_id, level_index: d.level_index,
      }))
    : []
  for (const v of data) {
    const result = lxnsFormatResult(v, levelValueMap)
    if (song) {
      r[v.level_index] = result
    } else {
      r.push(result)
    }
  }
  return r
}
