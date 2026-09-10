/**
 * 曲库/别名合并（源 core/merge/__init__.py 直译，设计 §5.3 ⚠️最高风险段）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * id 分段规则（源 set_version，禁简化）：
 *   id < 10000      → SD: 原id / DX: id+10000
 *   10000 ≤ id < 100000 → DX: 原id / SD: id-10000
 *   id ≥ 100000     → 宴谱（utage，type=DX）
 */
import { DX_CN_VERSION } from '../constants.js'
import { Alias, Difficulties, Notes, Song, Stats } from './models.js'
import { MusicList } from './musicList.js'
import { AliasList } from './aliasList.js'

/**
 * DF `charts[n].notes` → 领域 Notes（源 `chart_notes_to_domain`）
 * DF 给的是**位置数组**（SD 4 项 / DX 5 项），按位序解析——见 `models.js:Notes` 的说明。
 */
export function chartNotesToDomain(notes) {
  return Notes(notes)
}

export function buildDifficulty(levelIndex, level, levelValue, noteDesigner, notes) {
  return Difficulties({
    level_index: levelIndex,
    level,
    level_value: levelValue,
    note_designer: noteDesigner,
    notes,
    dx_score: notes.total * 3,
    stats: null,
  })
}

/** DF 曲目缺白谱（Re:Master）而 LXNS 有时补挂 */
export function appendMissingDifficulty(song, diffs) {
  if (song.difficulties.length === diffs.length) return
  const diff = diffs[diffs.length - 1]
  song.difficulties.push(
    buildDifficulty(diff.difficulty, diff.level, diff.level_value, diff.note_designer, Notes(diff.notes))
  )
}

/**
 * 合并水鱼 + 落雪曲目数据（源 merge_music_data 直译）
 * @param {Array} divingFishList DF music_data 原始数组
 * @param {object|null} lxnsSongs LXNS song/list 原始响应（{songs, genres, versions}）
 * @param {Record<string, Array>} statsMap DF chart_stats.charts（songIdStr → Stats[]）
 * @returns {{ list: MusicList, levelValueMap: Record<string, number> }}
 */
export function mergeMusicData({ divingFishList = null, lxnsList = null, statsMap = {} }) {
  const songMap = new Map()
  const levelValueMap = {}

  if (divingFishList == null && lxnsList == null) {
    throw new Error('merge_music_data: 两数据源均为空')
  }

  // 水鱼
  if (divingFishList != null) {
    for (const raw of divingFishList) {
      const songId = parseInt(raw.id, 10)
      const song = Song({
        song_id: songId,
        song_name: raw.title,
        artist: raw.basic_info.artist,
        genre: raw.basic_info.genre,
        bpm: raw.basic_info.bpm,
        // ⚠️ 水鱼响应里的键是 `from`（源 pydantic 正是靠 `version: str = Field(alias="from")`
        //    才读得到）。写成 `.version` 会拿到 undefined ⇒ version_str 空 ⇒ 曲目详情卡的
        //    版本分类图标 src 退化成 `pic/.png`（全部坏图），版本检索也一并失效。
        //    保留 `.version` 兜底以防上游改回具名键。
        version_str: raw.basic_info.from ?? raw.basic_info.version,
        type: raw.type,
        isnew: raw.basic_info.is_new,
      })
      raw.ds.forEach((ds, n) => {
        const charts = raw.charts[n]
        const notes = chartNotesToDomain(charts.notes)
        song.difficulties.push(
          Difficulties({
            level_index: n,
            level: raw.level[n],
            level_value: ds,
            note_designer: charts.charter || '',
            notes,
            dx_score: notes.total * 3,
            stats: null,
          })
        )
        levelValueMap[`${songId}-${n}`] = ds
      })
      songMap.set(songId, song)
    }
  }

  // 落雪
  if (lxnsList != null) {
    const versions = lxnsList.versions
    const verMap = {}
    for (const v of versions) verMap[v.version] = v.title
    const newVersion = versions[versions.length - 1].version

    const setVersion = (raw, verType, sid, diffs) => {
      let song = songMap.get(sid)
      const base = diffs[0]
      if (song != null) {
        song.version_int = base.version
        if (base.kanji !== undefined && base.kanji !== null) {
          // SongDifficultyUtage
          song.kanji = base.kanji
          song.description = base.description
          song.is_buddy = base.is_buddy
        } else {
          appendMissingDifficulty(song, diffs)
        }
        return
      }

      const ver = base.version
      const diffVer = ver - (ver % 100)

      let difficulties
      if (sid > 100000) {
        // 宴谱：BuddyNotes 拆双难度，否则单难度
        const notesList = base.notes.left ? [base.notes.left, base.notes.right] : [base.notes]
        difficulties = notesList.map((notes, n) =>
          buildDifficulty(n, base.level, base.level_value, base.note_designer, Notes(notes))
        )
      } else {
        difficulties = diffs.map((d, n) =>
          buildDifficulty(n, d.level, d.level_value, d.note_designer, Notes(d.notes))
        )
      }

      song = Song({
        song_id: sid,
        song_name: raw.title,
        artist: raw.artist,
        genre: raw.genre,
        bpm: raw.bpm,
        version_str: DX_CN_VERSION[verMap[diffVer]]?.[1] ?? '',
        version_int: base.version,
        type: verType,
        isnew: newVersion === base.version,
        difficulties,
      })

      if (base.kanji !== undefined && base.kanji !== null) {
        song.kanji = base.kanji
        song.description = base.description
        song.is_buddy = base.is_buddy
      } else {
        appendMissingDifficulty(song, diffs)
      }

      songMap.set(sid, song)
    }

    for (const raw of lxnsList.songs) {
      const songId = raw.id
      if (songId < 10000) {
        if (raw.difficulties.standard?.length) setVersion(raw, 'SD', songId, raw.difficulties.standard)
        if (raw.difficulties.dx?.length) setVersion(raw, 'DX', songId + 10000, raw.difficulties.dx)
      } else if (songId < 100000) {
        if (raw.difficulties.dx?.length) setVersion(raw, 'DX', songId, raw.difficulties.dx)
        if (raw.difficulties.standard?.length) setVersion(raw, 'SD', songId - 10000, raw.difficulties.standard)
      } else if (raw.difficulties.utage?.length) {
        setVersion(raw, 'DX', songId, raw.difficulties.utage)
      }
    }
  }

  // 全服统计（水鱼 chart_stats，按难度 zip 就位）
  for (const [sid, statList] of Object.entries(statsMap)) {
    const song = songMap.get(parseInt(sid, 10))
    if (song == null) continue
    song.difficulties.forEach((diff, i) => {
      const stat = statList[i]
      if (stat == null) return
      // 必须过 Stats() 归一：chart_stats 里存在**空对象 `{}`**（实测 1420 个），
      // 源侧由 pydantic 补默认值，直接赋原值会让 stats.cnt/fit_diff 变 undefined，
      // 宴谱卡于是渲染出「擬 - NaN」（views.js 直接 pyRound2(stats.fit_diff)）。
      diff.stats = Stats(stat)
    })
  }

  const list = new MusicList([...songMap.values()])
  return { list, levelValueMap }
}

/**
 * 合并柚子 + 落雪 + 本地别名（源 merge_alias_data 直译）
 * @param {Array} yuzuAliases 柚子别名原始数组 [{song_id, name, alias[]}]
 * @param {object|null} lxnsAliases 落雪别名原始响应 {aliases: [{song_id, aliases[]}]}
 * @param {Record<string, string[]>|null} localAliasData 本地别名 {songIdStr: alias[]}
 */
export function mergeAliasData({ yuzuAliases, lxnsAliases = null, localAliasData = null }) {
  const aliasMap = new Map() // song_id → Map<alias, null>（保序去重）
  const songNameMap = new Map()

  const addAliases = (songId, aliases) => {
    if (!aliasMap.has(songId)) aliasMap.set(songId, new Map())
    const bucket = aliasMap.get(songId)
    for (const a of aliases) bucket.set(a, null)
  }

  for (const item of yuzuAliases ?? []) {
    addAliases(item.song_id, item.alias)
    if (item.name) {
      if (!songNameMap.has(item.song_id)) songNameMap.set(item.song_id, item.name)
    }
  }

  if (lxnsAliases != null) {
    for (const item of lxnsAliases.aliases) {
      let songId = item.song_id
      if (songId > 1000) songId += 10000
      addAliases(songId, item.aliases)
    }
  }

  if (localAliasData != null) {
    for (const [a, aliases] of Object.entries(localAliasData)) {
      addAliases(parseInt(a, 10), aliases)
    }
  }

  const root = [...aliasMap.entries()]
    .filter(([, aliases]) => aliases.size > 0)
    .map(([songId, aliases]) => Alias({
      song_id: songId,
      song_name: songNameMap.get(songId) ?? '',
      alias: [...aliases.keys()],
    }))
    .sort((a, b) => a.song_id - b.song_id)

  return new AliasList(root)
}
