/**
 * 领域模型（源 core/merge/models/*.py → 普通对象 + 工厂函数，设计 §5.3）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * JSON 字段名与源 schema 强一致（snake_case），merge_music_data.json 可直接载入/回写。
 * 校验器语义（Pydantic field_validator before）转译为 normalize 函数：
 *   - rate/fc/fs 空串 → null
 *   - type: standard→SD / utage→DX / 其余大写
 */

/** 源 merge/models/score.py Result.type 校验器 */
export function normalizeType(v) {
  if (v === 'standard') return 'SD'
  if (v === 'utage') return 'DX'
  return String(v).toUpperCase()
}

/** 空串 → null（rate/fc/fs 校验器语义） */
export function emptyToNull(v) {
  return v === '' || v === undefined ? null : v
}

/**
 * notes 字段归一（**两种来源形状不同，必须都吃**）
 *
 * ⚠️ 水鱼 `music_data.json` 的 `charts[n].notes` 是**位置数组**，不是对象：
 *   SD 谱 4 项 `[tap, hold, slide, brk]`（源 `Notes1`）
 *   DX 谱 5 项 `[tap, hold, slide, touch, brk]`（源 `Notes2`）
 * 源侧走 pydantic，会把数组按位置套进 namedtuple；端口若当对象读 `.tap`，全取到 undefined
 * → 五项与 total 一律归零（曾因此让合并库里 99% 的难度 notes 变成 0，而 music_data.json 正常）。
 *
 * 落雪侧则是具名对象（`{total, tap, hold, slide, touch, break}`，`break` 为别名）。
 *
 * total 缺省时按五项求和（源 `chart_notes_to_domain` 同口径）；落雪自带 total 则以其为准。
 */
export function Notes(data = {}) {
  const src = Array.isArray(data) ? notesFromTuple(data) : (data ?? {})
  const tap = src.tap ?? 0
  const hold = src.hold ?? 0
  const slide = src.slide ?? 0
  const touch = src.touch ?? 0
  const brk = src.brk ?? src.break ?? 0
  return {
    total: src.total ?? (tap + hold + slide + touch + brk),
    tap,
    hold,
    slide,
    touch,
    brk,
  }
}

/** 位置数组 → 具名字段（按源 namedtuple 的位序；4 项无 touch，5 项才有） */
function notesFromTuple(arr) {
  const [tap, hold, slide, a, b] = arr
  return arr.length >= 5
    ? { tap, hold, slide, touch: a, brk: b }
    : { tap, hold, slide, brk: a }
}

export function Stats(data = null) {
  if (!data) return null
  return {
    cnt: data.cnt ?? 0,
    diff: data.diff ?? '',
    fit_diff: data.fit_diff ?? 0,
    avg: data.avg ?? 0,
    avg_dx: data.avg_dx ?? 0,
    std_dev: data.std_dev ?? 0,
    dist: data.dist ?? [],
    fc_dist: data.fc_dist ?? [],
  }
}

export function Difficulties(data = {}) {
  return {
    level_index: data.level_index ?? 0,
    level: data.level ?? '',
    level_value: data.level_value ?? 0,
    note_designer: data.note_designer ?? '',
    notes: Notes(data.notes ?? {}),
    dx_score: data.dx_score ?? 0,
    stats: Stats(data.stats ?? null),
  }
}

export function Song(data = {}) {
  return {
    song_id: data.song_id ?? 0,
    song_name: data.song_name ?? '',
    artist: data.artist ?? '',
    genre: data.genre ?? '',
    bpm: data.bpm ?? 0,
    version_str: data.version_str ?? '',
    version_int: data.version_int ?? 0,
    type: normalizeType(data.type ?? ''),
    isnew: data.isnew ?? false,
    difficulties: (data.difficulties ?? []).map(Difficulties),
    // 宴（utage）
    kanji: data.kanji ?? null,
    description: data.description ?? null,
    is_buddy: data.is_buddy ?? null,
  }
}

/** 源 merge/models/score.py：已游玩成绩 */
export function PlayedResult(data = {}) {
  return {
    song_id: data.song_id ?? 0,
    song_name: data.song_name ?? '',
    level: data.level ?? '',
    level_index: data.level_index ?? 0,
    level_value: data.level_value ?? 0,
    type: normalizeType(data.type ?? ''),
    rating: data.rating ?? 0,
    achievements: data.achievements ?? 0,
    rate: emptyToNull(data.rate ?? null),
    fc: emptyToNull(data.fc ?? null),
    fs: emptyToNull(data.fs ?? null),
    dx_score: data.dx_score ?? 0,
    dx_star: data.dx_star ?? null,
    upload_time: data.upload_time ?? null,
    level_label: data.level_label ?? null,
  }
}

/** 未游玩占位（单曲成绩卡里保留定数与难度位） */
export function NotPlayedResult(data = {}) {
  return {
    level_value: data.level_value ?? 0,
    song_id: data.song_id ?? 0,
    level_index: data.level_index ?? 0,
    notPlayed: true,
  }
}

export function Best50(data = {}) {
  return {
    sd_total: data.sd_total ?? 0,
    dx_total: data.dx_total ?? 0,
    sd: (data.sd ?? []).map(PlayedResult),
    dx: (data.dx ?? []).map(PlayedResult),
  }
}

/** 收藏品（称号/头像/名牌等，LXNS Collection） */
export function Collection(data = null) {
  if (!data || typeof data !== 'object') return null
  return {
    id: data.id ?? 0,
    name: data.name ?? '',
    color: emptyToNull(data.color ?? null),
    description: data.description ?? null,
    genre: data.genre ?? null,
  }
}

/** 玩家（源 merge/models/player.py Player） */
export function Player(data = {}) {
  return {
    name: data.name ?? '',
    rating: data.rating ?? 0,
    friend_code: data.friend_code ?? 0,
    course_rank: data.course_rank ?? 0,
    class_rank: data.class_rank ?? 0,
    star: data.star ?? null,
    trophy: Collection(data.trophy ?? null),
    icon: Collection(data.icon ?? null),
    name_plate: data.name_plate ?? null,
    frame: Collection(data.frame ?? null),
    upload_time: data.upload_time ?? null,
  }
}

export function Alias(data = {}) {
  return {
    song_id: data.song_id ?? 0,
    song_name: data.song_name ?? '',
    alias: data.alias ?? [],
  }
}

export function RiseResult(data = {}) {
  return {
    ...PlayedResult(data),
    old_rating: data.old_rating ?? 0,
    old_achievements: data.old_achievements ?? 0,
    old_rate: data.old_rate ?? 'D',
  }
}

/** 数据源（源 ServiceName 枚举：值用于「Data from ...」展示） */
export const ServiceName = {
  DIVINGFISH: 'Diving-Fish',
  LXNS: 'Lxns-Network',
}

/** user.json 里的短名 → 展示名 */
export function serviceDisplay(service) {
  return service === 'lxns' ? ServiceName.LXNS : ServiceName.DIVINGFISH
}

export function serviceNameByIndex(indexStr) {
  const mapping = { 0: 'df', 1: 'lxns' }
  return mapping[String(indexStr)] ?? null
}

export function serviceHelp() {
  return ['「0」：Diving-Fish', '「1」：Lxns-Network'].join('\n')
}

/** 主题（源 Theme 枚举：值=资源目录名；索引序 0=prism_plus 1=circle） */
export const ThemeName = {
  PRISM_PLUS: 'prism_plus',
  CIRCLE: 'circle',
}

export function themeNameByIndex(indexStr) {
  const mapping = { 0: 'prism_plus', 1: 'circle' }
  return mapping[String(indexStr)] ?? null
}

export function themeHelp() {
  return ['「0」：prism_plus', '「1」：circle'].join('\n')
}
