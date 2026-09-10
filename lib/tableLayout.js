/**
 * 定数表 / 完成表 / 牌子进度 / 等级进度 的纯几何层（ADR-7、设计 §8.2/§8.3）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot。
 *
 * 本模块**只做布局算术**：输入曲目/成绩数据，输出坐标与尺寸；不碰文件、不碰贴图名、
 * 不构造渲染元素 —— 因此可在不加载曲库的前提下单测（`tests/tableLayout.test.js`）。
 *
 * 关键背景（ADR-7）：源插件把定数表/完成表叠在 `更新定数表`/`更新完成表` 命令**运行时预生成**
 * 的整页底图上（static/mai/rating_table/{定数}.png、plate_table/{版本}.png）。那批图是本机
 * NoneBot 实例的产物、不在上游资源包内，故本插件不读取它们，改由 HTML/CSS 侧按**源生成器
 * （core/image/update_table.py）的同一套坐标**重建底图。以下常量即该文件的直译。
 *
 * ⚠️ 源的「底图生成器」与「运行时叠加器」各自复制了一遍 current_y 累加逻辑
 * （update_table.py ↔ rating_table.py / plate_table.py），是天然漂移点。本模块把它收敛成
 * 一次计算，两侧共用同一份 groups —— 这正是端口相对源的结构性改进，勿再拆回两处。
 */

// 源 rating_table.py:32 RatingGridConfig
export const RATING_GRID = {
  startX: 140, startY: 450, gap: 85, rowCount: 14,
  statsFirstLineX: 534, statsFirstLineY: 238,
  statsSecondLineX: 292, statsSecondLineY: 323,
}

// 源 plate_table.py:55 PlateGridConfig
export const PLATE_GRID = { startX: 180, startY: 490, gap: 96, rowCount: 12 }

/** 源 update_table.py:_generate_bg 的 separator.png 落点（定数表 360 / 完成表 400） */
export const SEPARATOR = { rating: 360, plate: 400 }

/** 源 generate_frosted_card 的卡片框（PIL box 的 right/bottom 为开区间 → 宽 1300） */
const CARD = { x: 50, w: 1300, ratingTop: 404, plateTop: 444, bottomPad: 230, plateBottomPad: 180 }

/** 组序遍历（源 `(len(songs) - 1) // 14 + 1` 的等价写法，负长度不参与） */
function rowsOf(count, perRow) {
  return Math.floor((count - 1) / perRow) + 1
}

// =====================================================================
// 定数表（源 update_table.py:121 update_rating_table）
// =====================================================================

/**
 * 定数表布局。**以 `mai.totalLevelData[level]` 为唯一真源。**
 *
 * ⚠️ 定数表按「标签」分页，标签由定数派生：x.0–x.5 归 `x` 页、x.6–x.9 归 `x+` 页，
 * 两页是**各自独立的整页**（实测 `12`={12.0…12.5}、`12+`={12.6…12.9}）。
 * 严禁从原始定数用 Math.floor 之类反推标签或重新分组 ——
 * `MusicList.byLevelList()`（lib/merge/musicList.js:48）已按 diff.level 分键并降序，直接用。
 *
 * 键序安全说明：本函数的 levelData 是 `mai.totalLevelData[标签]`，其键是 `toFixed(1)` 产出的
 * **含小数点**字符串（"13.0"、"13.7"），不属于 JS 的数组下标样式，故 `Object.entries` 保持插入序 ——
 * 与 `levelBuckets` 那类整数样式键（"13"、"13+"）不同，此处**不会**被重排。
 *
 * @param {Record<string, Array>} levelData 定数（如 "13.7"）→ SimpleSong[]，键已降序
 * @returns {{height:number, card:object, separatorHeight:number, groups:Array, footer:object}}
 */
export function ratingTableLayout(levelData) {
  const bucket = levelData ?? {}
  const groups = []
  let currentY = RATING_GRID.startY
  for (const [ds, songs] of Object.entries(bucket)) {
    if (!songs?.length) continue
    const rows = rowsOf(songs.length, RATING_GRID.rowCount)
    const songsOut = songs.map((song, num) => {
      const row = Math.floor(num / RATING_GRID.rowCount)
      const col = num % RATING_GRID.rowCount
      return { song, x: RATING_GRID.startX + col * RATING_GRID.gap, y: currentY + row * RATING_GRID.gap }
    })
    // 源 label 坐标 (70, START_Y + 35) anchor lm，fot 40px
    groups.push({ ds, labelX: 70, labelY: currentY + 35, songs: songsOut })
    currentY += rows * RATING_GRID.gap + 30
  }
  const height = currentY + CARD.bottomPad
  return {
    height,
    card: { x: CARD.x, y: CARD.ratingTop, w: CARD.w, h: currentY - CARD.ratingTop },
    separatorHeight: SEPARATOR.rating,
    groups,
    footer: { x: 700, y: height - 75 },
  }
}

/**
 * 等级 15 定数表布局（源 update_table.py:63 update_level_15_rating_table）
 * 3 列 × 425/450 的大格；不足处补占位格（song === null）。
 * @param {Array} songs SimpleSong[]（源 mai.total_level_data["15"]["15.0"]）
 */
export function level15Layout(songs) {
  const list = songs ?? []
  const count = list.length
  const lines = Math.floor(count / 3) + (count % 3 ? 1 : 0)
  const height = 650 + lines * 450
  const cells = []
  for (let i = 0; i < lines * 3; i++) {
    const row = Math.floor(i / 3)
    const col = i % 3
    cells.push({
      song: i < count ? list[i] : null,
      x: 100 + col * 425,
      y: 500 + row * 450,
    })
  }
  return { height, separatorHeight: SEPARATOR.rating, cells, footer: { x: 700, y: height - 75 } }
}

// =====================================================================
// 完成表（源 update_table.py:215 _draw_plate）
// =====================================================================

/**
 * 升级键：源 `get_ds_sort_key`（update_table.py:277）
 * 舞ReMASTER 曲取 difficulties[4].level_value，其余取 difficulties[3]。
 * 源另有一重 `song in remaster_song_list` 判定，但两份列表都由同一曲库解析而来，
 * 对「舞」列表内的曲目而言与 id 集合判定等价，故此处只用 id 集。
 */
function plateSortValue(song, remasterIdSet) {
  if (remasterIdSet?.has(song.song_id) && song.difficulties?.[4]) {
    return song.difficulties[4].level_value
  }
  return song.difficulties?.[3]?.level_value ?? 0
}

/** 源 _draw_plate 内 `songs.sort(key=get_ds_sort_key, reverse=True)`（原地排序，stable） */
export function sortPlateSongs(songs, { remasterIdSet = null } = {}) {
  songs.sort((a, b) => plateSortValue(b, remasterIdSet) - plateSortValue(a, remasterIdSet))
  return songs
}

/**
 * 源 update_table.py:_get_level_dict —— 全等级空桶，**顺序为 reversed(LEVEL_LIST)**。
 *
 * ⚠️⚠️ 必须用数组而非普通对象存这些桶：Python dict 保插入序，而 JS 普通对象会把
 * **整数样式的键按数值升序提前**（"1","2",…,"15" 全部排在 "14+","13+"… 之前），
 * 于是 `reversed(LEVEL_LIST)` 的顺序会被静默打乱 —— 高度算对、**行位却全错**。
 * 实测：定数表/完成表的组序会变成 11,12,13,14,13+,12+… 而非源的 15,14+,14,13+,13,…。
 * 故本模块一律以「有序数组 of {level, songs}」承载等级分组，永不依赖对象键序。
 *
 * @param {string[]} levelList 源 LEVEL_LIST
 * @returns {Array<{level:string, songs:Array}>}
 */
export function levelBuckets(levelList) {
  const buckets = []
  for (let i = levelList.length - 1; i >= 0; i--) buckets.push({ level: levelList[i], songs: [] })
  return buckets
}

/** 按等级取桶（源 `level_dict[level].append(song)`）；等级不在表内返回 null（源此处会 KeyError） */
export function bucketOf(buckets, level) {
  return buckets.find(b => b.level === level) ?? null
}

/**
 * 完成表布局。
 *
 * ⚠️ 组内**必须先排序**再算坐标 —— 源在同一循环体里先 sort 再 divmod 布点，
 * 顺序即画面顺序（坐标依赖 num）。组间顺序取传入 buckets 的数组序。
 *
 * @param {Array<{level:string, songs:Array}>} buckets 见 levelBuckets（顺序即画面组序）
 * @param {object} [opts]
 * @param {number|null} [opts.pages] 舞/霸者分页序号（0 基）；非 null 时输出 `Pages n/2`
 * @param {Set<number>|null} [opts.remasterIdSet] 舞ReMASTER id 集（仅舞/霸者传）
 */
export function plateTableLayout(buckets, { pages = null, remasterIdSet = null } = {}) {
  const groups = []
  let currentY = PLATE_GRID.startY
  for (const { level, songs: rawSongs } of buckets ?? []) {
    if (!rawSongs?.length) continue
    const songs = sortPlateSongs([...rawSongs], { remasterIdSet })
    const songsOut = songs.map((song, num) => {
      const row = Math.floor(num / PLATE_GRID.rowCount)
      const col = num % PLATE_GRID.rowCount
      const isRemaster = Boolean(remasterIdSet?.has(song.song_id))
      return {
        song,
        isRemaster,
        x: PLATE_GRID.startX + col * PLATE_GRID.gap,
        y: currentY + row * PLATE_GRID.gap,
      }
    })
    // 源 label (72, START_Y + 40) anchor lm，fot 40px
    groups.push({ level, labelX: 72, labelY: currentY + 40, songs: songsOut })
    currentY += rowsOf(songs.length, PLATE_GRID.rowCount) * PLATE_GRID.gap + 30
  }
  const height = currentY + CARD.plateBottomPad
  return {
    height,
    card: { x: CARD.x, y: CARD.plateTop, w: CARD.w, h: currentY - CARD.plateTop },
    separatorHeight: SEPARATOR.plate,
    groups,
    footer: { x: 700, y: height - 75 },
    pagesText: pages === null ? null : { x: 700, y: height - 140, text: `Pages ${pages + 1}/2` },
  }
}

/**
 * 舞/霸者两页拆分（源 update_table.py:313 update_wu_plate_table）
 * 以 '13' 为界：13 以上（keys[:idx]）为第 1 页，13 及以下（keys[idx:]）为第 2 页。
 *
 * ⚠️ 源此处 `keys.index("13")` 在缺 '13' 时抛 ValueError；运行时叠加侧
 * （plate_table.py:243）却写成 `if "13" in keys else len(keys)` —— 两处行为不同且是**源有意为之**，
 * 故本函数保持抛错语义，调用方若需运行时侧语义请自行判空（见 R10，勿"顺手修成一致"）。
 *
 * @param {Array<{level:string, songs:Array}>} buckets
 * @returns {[Array, Array]}
 */
export function splitWuBuckets(buckets) {
  const idx = (buckets ?? []).findIndex(b => b.level === '13')
  if (idx === -1) throw new Error("splitWuBuckets: level '13' not found in level buckets")
  return [buckets.slice(0, idx), buckets.slice(idx)]
}

// =====================================================================
// 牌子进度（源 plate_table.py:479 DrawPlateProgress）
// =====================================================================

/** 源 _get_display_row_count：每难度最多画 4 行（超出仅提示剩余数） */
export function displayRowCount(count) {
  if (count <= 0) return 1
  return Math.min(Math.floor((count - 1) / 13) + 1, 4)
}

/** 牌子进度页的分段起点与每段高度（源 START_Y=455，段间 +(max_row+1)*96+100） */
const PLATE_PROGRESS = { startX: 84, startY: 455, perRow: 13, rowAdvance: 100 }

/**
 * 牌子进度布局。
 *
 * @param {Array<{label:string, color:string, count:number, songs:Array}>} sections
 *        展示序（Re:Master→Basic，或 Master→Basic）；`count` 为该难度**未完成**数
 * @returns {{height:number, card:object, separatorHeight:number, footer:object, sections:Array}}
 */
export function plateProgressLayout(sections) {
  const out = []
  let currentY = 395
  // 高度只取决于各行数；且**绘制侧的实际推进量恒等于 displayRowCount**：
  // 未中断时段 max_row+1 == ceil(count/13)；中断时段（count≥52，在 num=51 处 break）
  // max_row 停在 3 → 4，而 displayRowCount(≥52) 亦为 4。源两处公式因此等价，此处收敛为一处。
  for (const s of sections) currentY += displayRowCount(s.count) * PLATE_GRID.gap + PLATE_PROGRESS.rowAdvance
  const height = currentY + 180

  let startY = PLATE_PROGRESS.startY
  for (const s of sections) {
    const cells = []
    const songs = s.songs ?? []
    for (let num = 0; num < songs.length; num++) {
      const row = Math.floor(num / PLATE_PROGRESS.perRow)
      const col = num % PLATE_PROGRESS.perRow
      const x = PLATE_PROGRESS.startX + col * PLATE_GRID.gap
      const y = startY + row * PLATE_GRID.gap
      // 源：≥51 首且剩余不止 1 首 → 改成「余 N 个未完成」提示并**中断本段**（用 break，勿用 continue）
      if (num >= 51 && songs.length - num !== 1) {
        cells.push({ overflow: songs.length - num, x, y })
        break
      }
      cells.push({ song: songs[num], x, y })
    }
    out.push({ ...s, y: startY, cells })
    startY += displayRowCount(s.count) * PLATE_GRID.gap + PLATE_PROGRESS.rowAdvance
  }

  return {
    height,
    card: { x: 50, y: 349, w: 1300, h: currentY - 349 },
    separatorHeight: 305,
    footer: { x: 700, y: height - 75 },
    sections: out,
  }
}

// =====================================================================
// 等级进度 / 分数列表（源 handler.py:621 draw_level_progress / :734 draw_level_score_list）
// =====================================================================

/** 源 handler.py:68 get_rows：count==0 → 0，否则向上取整 */
export function getRows(count, rowSize) {
  if (count === 0) return 0
  return Math.floor((count + rowSize - 1) / rowSize)
}

/** 源 get_played_rows：至少 4 行（成绩格 5 列 / 行高 109） */
export function playedRows(count) {
  return Math.max(4, getRows(count, 5))
}

/** 源 get_notplayed_rows：至少 4 行（未游玩格 20 列 / 行高 65） */
export function notPlayedRows(count) {
  return Math.max(4, getRows(count, 20))
}

/** 等级进度页高度（源 draw_level_progress 三个分支） */
export function levelPlanHeights({ category, completed, unfinished, notplayed, page = 1 }) {
  const c = completed?.length ?? 0
  const u = unfinished?.length ?? 0
  const n = notplayed?.length ?? 0

  if (category === 'completed' || category === 'unfinished') {
    const data = category === 'completed' ? completed : unfinished
    const perPage = 80
    const totalPage = Math.max(1, Math.floor((data.length - 1) / perPage) + 1)
    const p = Math.max(1, Math.min(page, totalPage))
    const display = data.slice((p - 1) * perPage, p * perPage)
    const ySize = playedRows(display.length) * 109
    return { mode: 'category', page: p, totalPage, display, ySize, height: 240 + ySize + 120 }
  }

  if (category === 'notplayed') {
    const ySize = notPlayedRows(n) * 65
    return { mode: 'notplayed', ySize, height: Math.max(240 + ySize + 120, 600) }
  }

  // DEFAULT：三段（已完成 / 未完成 / 未游玩），各自有截断上限
  // ⚠️ comp_limit 与三段上限**同时决定画面内容与高度**，不可只用于其一处
  const compLimit = (!u && !n) ? 60 : 30
  const cY = playedRows(Math.min(c, compLimit)) * 109 + 140
  const uY = playedRows(Math.min(u, 30)) * 109 + 140
  const nY = notPlayedRows(Math.min(n, 100)) * 65 + 140
  return { mode: 'plan', compLimit, cY, uY, nY, height: 150 + cY + uY + nY }
}

/** 分数列表页高度与分页（源 draw_level_score_list） */
export function levelScoreListLayout(total, page = 1) {
  const endPage = Math.max(1, Math.floor((total + 79) / 80))
  const p = Math.max(1, Math.min(page, endPage))
  const toPage = p < endPage ? 80 : (total % 80 || 80)
  const line = Math.floor((toPage + 4) / 5)
  let plc
  if (p < endPage) {
    plc = line * 109 + 130 * 4
  } else {
    const multiplier = Math.floor((toPage + 19) / 20)
    const actualLine = toPage <= 20 ? 4 : line
    plc = actualLine * 109 + 130 * multiplier
  }
  return { page: p, endPage, toPage, line, plc, height: 280 + plc }
}
