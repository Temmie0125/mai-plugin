/**
 * 表格族数据整形（源 core/image/{rating_table,plate_table}.py 的处理段直译）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 *
 * 纯函数、零 I/O、零渲染 —— 与 lib/tableLayout.js（几何）配对，构成本批的主要单测面。
 */
import { computeRating } from './calc.js'
import { RiseResult } from './merge/models.js'
import {
  ACHIEVEMENT_LIST, ALL_VERSION, COMBO_PLUS, COMBO_SP, DX_CN_VERSION, LEVEL_INDEX_MAP, LEVEL_LIST,
  RANK_PLUS, RANK_SP, STATISTICS_KEYS, SYNC_D_SP, SYNC_PLUS,
} from './constants.js'

/**
 * 目标 → (类型, 阈值)（源 handler.py:60 PLAN_MAP）
 *
 * ⚠️ 源 `ACHIEVEMENT_LIST[i - 1]` 在 i=0 时走 Python **负下标**取末位（100.5），不是 0 号元素。
 */
export const PLAN_MAP = (() => {
  const m = {}
  RANK_PLUS.forEach((p, i) => {
    const idx = i - 1 < 0 ? ACHIEVEMENT_LIST.length - 1 : i - 1
    m[p] = [0, ACHIEVEMENT_LIST[idx]]
  })
  COMBO_PLUS.forEach((p, i) => { m[p] = [1, i] })
  SYNC_PLUS.forEach((p, i) => { m[p] = [2, i] })
  return m
})()

/**
 * 牌子达成条件（源 plate_table.py:67 PLAN_CRITERIA）
 * 将/者按数值阈值（>=100 / >=80），其余按成员判定；prefix 决定达成图标来源
 * （RANK 前缀实际不会用到 —— 将/者走 UI_TTR_Rank_ 分支，见 plateIconName）
 */
export const PLAN_CRITERIA = {
  '者': { attr: 'achievements', values: [80], prefix: 'RANK' },
  '极': { attr: 'fc', values: COMBO_SP, prefix: 'UI_CHR_PlayBonus_' },
  '極': { attr: 'fc', values: COMBO_SP, prefix: 'UI_CHR_PlayBonus_' },
  '将': { attr: 'achievements', values: [100], prefix: 'RANK' },
  '神': { attr: 'fc', values: ['ap', 'app'], prefix: 'UI_CHR_PlayBonus_' },
  '舞舞': { attr: 'fs', values: ['fsd', 'fsdp', 'fsdpx', 'fsdp+'], prefix: 'UI_CHR_PlayBonus_' },
}

/**
 * 单个谱面是否达成牌子要求（源 plate_table.py:120 _is_qualified）
 * @param {object|null} play PlayedResult
 * @param {string} plan 称号字（将/极/極/神/者/舞舞）
 */
export function isPlateQualified(play, plan) {
  if (!play) return false
  const cfg = PLAN_CRITERIA[plan]
  if (!cfg) return false
  const val = play[cfg.attr]
  if (plan === '将') return val >= 100
  if (plan === '者') return val >= 80
  return cfg.values.includes(val)
}

/**
 * 定数完成表的统计与逐曲成绩索引（源 rating_table.py:116 _process_rating_table_data）
 *
 * ⚠️ 大小写陷阱：`compute_rating(onlyrate=True)` 返回的是**展示名**（"SSSp"/"Sp"…），
 * 本函数按源 `.lower()` 后再与 `RANK_SP[-6:]`（全小写）比对；
 * 而绘制侧 `_get_rank_icon(rate)` **不做 lower**，直接用展示名拼文件名
 * （磁盘上确实是 UI_TTR_Rank_SSSp.png）。两处口径不同，勿统一。
 *
 * @param {string} rating 定数字面（"13"/"13+"），按 `level` 字段过滤（源同款，不用 level_value）
 * @param {Array} playResult PlayedResult[]
 * @returns {{statistics: Record<string, number>, playedMap: Map<number, Map<number, object>>}}
 */
export function processRatingTableData(rating, playResult) {
  const statistics = {}
  for (const k of STATISTICS_KEYS) statistics[k] = 0
  const playedMap = new Map()
  const rankSp = RANK_SP.slice(-6)

  for (const d of playResult ?? []) {
    if (d.level !== rating) continue
    if (!playedMap.has(d.song_id)) playedMap.set(d.song_id, new Map())
    playedMap.get(d.song_id).set(d.level_index, {
      achievements: d.achievements, level: d.level, fc: d.fc,
    })

    const rate = computeRating(d.level_value, d.achievements, { onlyrate: true }).toLowerCase()
    if (d.achievements >= 80) statistics.clear += 1

    if (rankSp.includes(rate)) {
      for (const r of rankSp.slice(0, rankSp.indexOf(rate) + 1)) statistics[r] += 1
    }
    if (d.fc && COMBO_SP.includes(d.fc)) {
      for (const f of COMBO_SP.slice(0, COMBO_SP.indexOf(d.fc) + 1)) statistics[f] += 1
    }
    if (d.fs) {
      if (d.fs === 'sync') statistics.sync += 1
      else if (SYNC_D_SP.includes(d.fs)) {
        for (const s of SYNC_D_SP.slice(0, SYNC_D_SP.indexOf(d.fs) + 1)) statistics[s] += 1
      }
    }
  }
  return { statistics, playedMap }
}

/**
 * 全清徽章档位（源 rating_table.py:103 _calc_achievements_fc）
 *
 * 返回 -1 表示未达成任何档位；否则为已连续达成的最高档下标。
 * @param {Array<number>} scoreList 达成率（非 plan）或 COMBO_SP 下标（plan）
 * @param {number} lvlistNum 该等级谱面总数
 * @param {boolean} plan fc/ap 计划模式
 */
export function calcAchievementsFc(scoreList, lvlistNum, plan) {
  let r = -1
  const thresholds = plan ? [0, 1, 2, 3] : ACHIEVEMENT_LIST.slice(-6)
  for (const t of thresholds) {
    const count = (scoreList ?? []).filter(s => s >= t).length
    if (count === lvlistNum) r += 1
    else break
  }
  return r
}

// =====================================================================
// 完成表（源 plate_table.py:231 PlateTable.process 及其两个数据分支）
// =====================================================================

/** 显示用等级：舞ReMASTER 曲取第 5 难度，其余取第 4（源 get_display_level / _value） */
function displayDiff(song, remasterIdSet) {
  return remasterIdSet.has(song.song_id) && song.difficulties?.[4]
    ? song.difficulties[4]
    : song.difficulties?.[3]
}

/** 源 _get_level_dict：reversed(LEVEL_LIST) 的空桶（Map 保序，勿换普通对象） */
function emptyLevelMap() {
  const m = new Map()
  for (let i = LEVEL_LIST.length - 1; i >= 0; i--) m.set(LEVEL_LIST[i], [])
  return m
}

/**
 * 完成表数据整形（源 plate_table.py:231 process）
 *
 * ⚠️ 两条分支的 played_map 键序来源不同，且**都是对的**，勿统一：
 *   - 非舞：键序 = 曲目按 level_value 降序首次出现的顺序；
 *   - 舞：键序 = reversed(LEVEL_LIST)（桶预先建好，只 append 有曲的等级）。
 *   由于「标签由定数派生」（x.0–x.5→x、x.6–x.9→x+，区间互不交错），两者实际一致 ——
 *   这正是数据不变量测试所守的东西；若哪天合并层破坏了它，此处会出现行错位。
 *
 * @param {object} o
 * @param {string} o.version 短版本字（"真"/"舞"…，用于贴图路径）
 * @param {string} o.versionName VERSION_MAP 的版本名（"熊&华"…）
 * @param {boolean} o.isWu 是否舞/霸者
 * @param {number} o.page 1 基页码（仅舞有效）
 * @param {string} o.plan 称号字
 * @param {Array} o.playResult PlayedResult[]
 * @param {Record<string, number[]>} o.plateIdList mai.totalPlateIdList
 * @param {object} o.totalList mai.totalList（用 byIdList）
 * @returns {{totalCount:number, remasterCount:number, levels:Map, displayLevels:string[], slotCounts:number[], completedCount:number}}
 */
export function processPlateTable({
  version, versionName, isWu, page, plan, playResult, plateIdList, totalList,
}) {
  let totalCount
  let remasterCount = 0
  /** @type {Map<string, Map<number, Array>>} */
  let playedMap = new Map()
  /** @type {Map<number, object>} */
  let songsById = new Map()

  if (isWu) {
    const wuIdList = plateIdList['舞'] ?? []
    const reIdSet = new Set(plateIdList['舞ReMASTER'] ?? [])
    const wuSongList = totalList.byIdList(wuIdList)
    const byLevel = emptyLevelMap()

    wuSongList.sort((a, b) => displayDiff(b, reIdSet).level_value - displayDiff(a, reIdSet).level_value)
    const songIdToLevel = new Map()
    for (const s of wuSongList) songIdToLevel.set(s.song_id, displayDiff(s, reIdSet).level)

    for (const s of wuSongList) {
      const lv = displayDiff(s, reIdSet).level
      if (byLevel.has(lv)) byLevel.get(lv).push(s)
    }
    for (const [lv, songsInLv] of byLevel) {
      if (!songsInLv.length) continue
      const inner = new Map()
      for (const s of songsInLv) {
        inner.set(s.song_id, new Array(reIdSet.has(s.song_id) ? 5 : 4).fill(null))
      }
      playedMap.set(lv, inner)
    }
    for (const d of playResult ?? []) {
      if (!songIdToLevel.has(d.song_id)) continue
      const slots = playedMap.get(songIdToLevel.get(d.song_id))?.get(d.song_id)
      if (slots && d.level_index < slots.length) slots[d.level_index] = d
    }
    songsById = new Map(wuSongList.map(s => [s.song_id, s]))
    totalCount = wuIdList.length
    remasterCount = reIdSet.size
  } else {
    const plateIds = plateIdList[versionName] ?? []
    const songList = totalList.byIdList(plateIds)
    const songIdToLevel = new Map(songList.map(s => [s.song_id, s.difficulties[3].level]))

    songList.sort((a, b) => b.difficulties[3].level_value - a.difficulties[3].level_value)
    for (const s of songList) {
      const lv = s.difficulties[3].level
      if (!playedMap.has(lv)) playedMap.set(lv, new Map())
      playedMap.get(lv).set(s.song_id, [null, null, null, null])
    }
    for (const d of playResult ?? []) {
      if (!songIdToLevel.has(d.song_id)) continue
      if (d.level_index === 4) continue // slot_num==4：白谱不参与
      playedMap.get(songIdToLevel.get(d.song_id)).get(d.song_id)[d.level_index] = d
    }
    songsById = new Map(songList.map(s => [s.song_id, s]))
    totalCount = plateIds.length
  }

  // 舞/霸者分页：keys 缺 '13' 时退化为「整表一页」（源运行时侧写法，与底图生成侧的
  // `keys.index("13")` 抛 ValueError 刻意不同 —— 见 tableLayout.splitWuBuckets 注释）
  const keys = [...playedMap.keys()]
  let displayLevels = keys
  if (isWu) {
    const idx = keys.includes('13') ? keys.indexOf('13') : keys.length
    displayLevels = page === 1 ? keys.slice(0, idx) : keys.slice(idx)
  }
  const displaySet = new Set(displayLevels)

  const levels = new Map()
  const finishedSongs = new Set()
  const difficultyResults = Array.from({ length: isWu ? 5 : 4 }, () => [])

  for (const [level, songsDict] of playedMap) {
    const levelProgress = []
    for (const [songId, results] of songsDict) {
      const qualifiedSlots = []
      results.forEach((play, idx) => { if (isPlateQualified(play, plan)) qualifiedSlots.push(idx) })
      results.forEach((play, slot) => {
        const chart = songsById.get(songId).difficulties[slot]
        difficultyResults[slot].push({
          song_id: songId,
          level_value: chart?.level_value ?? 0,
          qualified: qualifiedSlots.includes(slot),
        })
      })
      const completed = qualifiedSlots.length === results.length
      if (completed) finishedSongs.add(songId)
      levelProgress.push({ song_id: songId, results, qualified_slots: qualifiedSlots, completed })
    }
    levels.set(level, levelProgress)
  }

  // 源 process() 末尾：每个难度桶按 level_value 降序 —— 牌子进度页的曲绘顺序依赖它
  for (const charts of difficultyResults) charts.sort((a, b) => b.level_value - a.level_value)

  // 每难度的达标计数（源按 slot 汇总 difficulty_results）
  const slotCounts = difficultyResults.map(charts => charts.filter(c => c.qualified).length)

  return {
    totalCount,
    remasterCount,
    levels,
    displayLevels,
    displaySet,
    slotCounts,
    completedCount: finishedSongs.size,
    /** 按难度槽位归集的谱面（已按 level_value 降序）—— 牌子进度页用 */
    difficultyResults,
    /** 视图层用它把 levels 的行映射回 Song（重建底图网格需要曲绘/难度） */
    songsById,
  }
}

// =====================================================================
// 等级进度 / 分数列表（源 handler.py:621 / :734 的数据整形部分）
// =====================================================================

/** 源 CATEGORY 枚举（merge/models/enum.py:18）的字符串形态 */
export const CATEGORY = { DEFAULT: 'default', COMPLETED: 'completed', UNFINISHED: 'unfinished', NOTPLAYED: 'notplayed' }

/** 降序比较（源 sort(reverse=True)；同值相等以保持稳定） */
function desc(a, b) {
  if (a === b) return 0
  return a < b ? 1 : -1
}

/**
 * 等级进度三段归类（源 draw_level_progress 的循环与排序段）
 * @param {object} o
 * @param {string} o.level 定数字面
 * @param {string} o.plan 目标（PLAN_MAP 键，已小写）
 * @param {Array} o.playResult PlayedResult[]
 * @param {Map<number, Array>} o.byPlan mai.totalList.byPlan(level) 的结果
 * @returns {{completed:Array, unfinished:Array, notplayed:Array}}
 */
export function processLevelProgress({ level, plan, playResult, byPlan }) {
  const playedMap = new Map()
  for (const r of playResult ?? []) {
    if (r.level === level) playedMap.set(`${r.song_id}-${r.level_index}`, r)
  }
  const [planType, planValue] = PLAN_MAP[plan]
  const checkStatus = (res) => {
    if (planType === 0) return res.achievements >= planValue
    if (planType === 1) {
      return Boolean(res.fc && COMBO_SP.includes(res.fc) && COMBO_SP.indexOf(res.fc) >= planValue)
    }
    if (planType === 2) {
      if (!res.fs) return false
      if (SYNC_D_SP.includes(res.fs)) return SYNC_D_SP.indexOf(res.fs) >= planValue
      if (SYNC_SP.includes(res.fs)) return SYNC_SP.indexOf(res.fs) >= planValue
      return false
    }
    return false
  }

  const completed = []
  const unfinished = []
  const notplayed = []
  for (const [songId, diffs] of byPlan ?? new Map()) {
    for (const d of diffs) {
      const res = playedMap.get(`${songId}-${d.level_index}`)
      if (res) (checkStatus(res) ? completed : unfinished).push(res)
      else notplayed.push({ song_id: songId, level_index: d.level_index, level_value: d.level_value })
    }
  }

  const sortKey = { 0: 'achievements', 1: 'fc', 2: 'fs' }[planType] ?? 'achievements'
  const sortDefault = planType === 0 ? 0 : ''
  const keyOf = (r) => r[sortKey] ?? sortDefault
  completed.sort((a, b) => desc(keyOf(a), keyOf(b)))
  unfinished.sort((a, b) => desc(keyOf(a), keyOf(b)))
  notplayed.sort((a, b) => desc(a.level_value, b.level_value))
  return { completed, unfinished, notplayed }
}

/**
 * 分数列表筛选与排序（源 draw_level_score_list）
 * 定数为字符串时按 `level` 匹配，为数值时按 `level_value` 匹配（源同款二选一）
 */
export function processLevelScoreList({ rating, playResult }) {
  const isNum = typeof rating === 'number'
  return (playResult ?? [])
    .filter(x => (isNum ? x.level_value === rating : x.level === rating))
    .sort((a, b) => desc(a.achievements, b.achievements))
}

// =====================================================================
// 上分推荐（源 handler.py:200 get_rise_score_list）
// =====================================================================

/** 与 Python `random.sample` 等价：k 个互异元素、随机顺序 */
function defaultSample(arr, k) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a.slice(0, k)
}

/** 源 RISE_ACHIEVEMENT_LIST = ACHIEVEMENT_LIST[-4:] */
const RISE_ACH = ACHIEVEMENT_LIST.slice(-4)

/**
 * 上分推荐候选（源 handler.py:200）
 *
 * @param {Map<string,object>} oldRecords 已有成绩，键 `${song_id}-${level_index}`
 * @param {'sd'|'dx'} type 新旧版本分支（dx → 仅新版本曲；sd → 新版本之前的全部版本）
 * @param {Array} playResult 对应半边 B50（**须已按 rating 降序**，源取末位为最低分）
 * @param {string|null} level 目标等级（给出时不再按定数区间筛）
 * @param {number|null} score 目标涨幅
 * @param {{totalList:object, sample?:Function}} deps
 * @returns {{list:Array, lowestRa:number}}
 */
export function getRiseScoreList(oldRecords, type, playResult, level = null, score = null, deps = {}) {
  const { totalList, sample = defaultSample } = deps
  if (!playResult?.length) return { list: [], lowestRa: 0 }

  // 源 play_result[-1]：B50 已排序，末位即最低 rating / 其等级
  const last = playResult[playResult.length - 1]
  const lowestRa = last.rating
  const lowestLevel = last.level
  const lowestLevelIndex = LEVEL_INDEX_MAP[lowestLevel]
  const newLevelIndex = level ? LEVEL_INDEX_MAP[level] : lowestLevelIndex
  if (lowestLevelIndex > newLevelIndex) return { list: [], lowestRa: 0 }

  const targetRise = score || 1
  const ignoredSongIds = new Set(
    playResult.filter(p => p.achievements >= 100.5).map(p => p.song_id)
  )

  // ⚠️ 浮点顺序照搬源：`ceil((lowest_ra + target_rise) / max_ra_coefficient * 10) / 10`
  const maxRaCoefficient = ACHIEVEMENT_LIST[ACHIEVEMENT_LIST.length - 1] / 100 * 22.4
  const minDs = Math.ceil((lowestRa + targetRise) / maxRaCoefficient * 10) / 10
  const ds = level ? null : [minDs, minDs + 1]

  const versions = Object.values(DX_CN_VERSION)
  const newVersion = versions[versions.length - 1][versions[versions.length - 1].length - 1]
  const version = type === 'dx'
    ? newVersion
    : ALL_VERSION.slice(0, ALL_VERSION.indexOf(newVersion))

  const songs = totalList.filter({ level, level_value: ds, version_str: version, all_diff: false })
  const riseResult = []

  for (const song of songs) {
    const songId = song.song_id
    if (songId >= 100000 || ignoredSongIds.has(songId)) continue
    for (const diff of song.difficulties) {
      if (level && LEVEL_INDEX_MAP[diff.level] > newLevelIndex) continue

      const oldResult = oldRecords.get(`${songId}-${diff.level_index}`)
      const oldRa = oldResult ? Math.max(oldResult.rating, lowestRa) : 0

      for (const achievements of RISE_ACH) {
        const [newRa, newRate] = computeRating(diff.level_value, achievements, { israte: true })

        if (!oldResult) {
          if (newRa <= lowestRa) continue
          riseResult.push(RiseResult({
            song_id: songId, song_name: song.song_name, level_index: diff.level_index,
            type: song.type, rating: newRa, achievements,
            rate: newRate.toLowerCase(), level_value: diff.level_value,
          }))
          break
        }

        if (newRa - oldRa < targetRise) continue
        riseResult.push(RiseResult({
          song_id: songId, song_name: song.song_name, level_index: diff.level_index,
          type: song.type, rating: newRa, achievements,
          rate: newRate.toLowerCase(), level_value: diff.level_value,
          old_rating: oldResult.rating, old_achievements: oldResult.achievements,
          old_rate: oldResult.rate ?? 'D',
        }))
        break
      }
    }
  }

  // 源：先随机抽 5 条，再按 level_value 降序展示（采样随机、展示有序）
  const sampled = sample(riseResult, Math.min(riseResult.length, 5))
  sampled.sort((a, b) => b.level_value - a.level_value)
  return { list: sampled, lowestRa }
}
