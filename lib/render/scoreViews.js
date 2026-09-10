/**
 * 进度 / 分数列表 / 上分推荐页构建器（源 core/image/{plate_table,score}.py 坐标直译）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot。
 *
 * 与表格族共用 z 阶梯与装饰层（tableBgLayers / FROSTED / cardElement），故从 tableViews 引入。
 * ⚠️ 源 DrawScore.__init__ 硬编码 Theme.PRISM_PLUS —— 本族页面**不随用户主题变化**，
 * 此处一律用 'prism_plus' 字面量，不要接 user.theme。
 */
import fs from 'node:fs'
import {
  img, txt, picSrc, themedPicSrc, maiSrc, songChartSrc, tricolorGradientCss, whiledraw,
  DEFAULT_TEXT_COLOR, ID_TEXT_COLOR, DIFF_TEXT_COLOR, DIFF_BG_NAMES,
} from './views.js'
import { pyRound2, coloumWidth, changeColumnWidth } from './textwidth.js'
import { plateProgressLayout, levelScoreListLayout as levelScoreListLayoutFor } from '../tableLayout.js'
import { tableBgLayers, cardElement, footerElement, Z } from './tableViews.js'
import { DIFFS, RANK_MAP } from '../constants.js'

/** file:// URL → 本地路径（存在性预检用） */
function urlToPath(url) {
  return decodeURIComponent(url.replace(/^file:\/\/\//, ''))
}

/**
 * 牌子进度页（源 plate_table.py:479 DrawPlateProgress.draw）
 *
 * 每难度一段：进度条 + 该难度**未完成**谱面网格（每行 13，最多 4 行；≥51 首时改为
 * 「余 N 个未完成」提示）。段的展示序为难度倒序（Re:Master→Basic / Master→Basic）。
 *
 * @param {object} o
 * @param {string} o.version 短版本字（贴图路径）
 * @param {boolean} o.isWu
 * @param {string} o.plan 称号字
 * @param {object} o.data processPlateTable 输出
 * @param {string} o.botName
 */
export function plateProgressView({ version, isWu, plan, data, botName = '' }) {
  const numSlots = isWu ? 5 : 4
  // 源 new_diffs = DIFFS[:end][::-1]、new_color = _id_text_color[:end][::-1]（end=-1 时取前 4 项）
  const slice = numSlots === 5 ? DIFFS.slice() : DIFFS.slice(0, -1)
  const diffs = slice.slice().reverse()
  const colors = (numSlots === 5 ? ID_TEXT_COLOR.slice() : ID_TEXT_COLOR.slice(0, -1)).reverse()

  // 段数据：槽位倒序（源 reversed(data.difficulty_results)）
  const slots = [...data.slotCounts.keys()].reverse()
  const sections = slots.map((slot, n) => {
    const charts = data.difficultyResults[slot] ?? []
    const unqualified = charts.filter(c => !c.qualified)
    return {
      label: diffs[n],
      color: colors[n],
      count: unqualified.length,
      songs: unqualified.map(c => data.songsById.get(c.song_id)).filter(Boolean),
      completeSum: data.slotCounts[slot],
      plateCount: charts.length,
    }
  })

  const layout = plateProgressLayout(sections)
  const images = tableBgLayers(layout.height, layout.separatorHeight)
  const texts = []

  // 头部：进度底图 + 牌子徽章 + 总进度条 + 总计数
  images.push(img(picSrc('plate_progress_2.png'), 175, 20, null, null, { z: Z.OV_ART }))
  const plateArt = maiSrc('plate_version', `${version}${plan === '极' ? '極' : plan}.png`)
  if (!fs.existsSync(urlToPath(plateArt))) {
    throw new Error(`plate_version art missing: ${version}${plan}.png`)
  }
  images.push(img(plateArt, 200, 35, 1000, 161, { z: Z.OV_ART }))

  const total = data.totalCount
  const completeSum = data.completedCount
  const totalProgress = total === 0 ? 0 : completeSum / total
  if (totalProgress !== 0) {
    images.push(img(picSrc('progress_big.png'), 204, 219, Math.trunc(993 * totalProgress), 92,
      { crop: true, z: Z.OV_ART }))
  }
  texts.push(txt(completeSum === total ? 'COMPLETED!!!' : `${completeSum}/${total}`, 700, 240, 30,
    { font: 'fot', color: DEFAULT_TEXT_COLOR, anchor: 'mm', stroke: 3, strokeColor: '#ffffff', z: Z.OV_TEXT }))
  texts.push(txt(`${pyRound2(totalProgress * 100)}%`, 1190, 240, 30,
    { font: 'fot', color: DEFAULT_TEXT_COLOR, anchor: 'rm', stroke: 3, strokeColor: '#ffffff', z: Z.OV_TEXT }))

  // 每难度段
  for (const sec of layout.sections) {
    images.push(img(picSrc('progress_bg.png'), 198, sec.y - 85, null, null, { z: Z.OV_ART }))
    const pg = sec.plateCount === 0 ? 0 : sec.completeSum / sec.plateCount
    if (pg !== 0) {
      images.push(img(picSrc('progress_big.png'), 204, sec.y - 79, Math.trunc(993 * pg), 92,
        { crop: true, z: Z.OV_ART }))
    }
    texts.push(txt(sec.label, 220, sec.y - 57, 34,
      { font: 'fot', color: sec.color, anchor: 'lm', stroke: 4, strokeColor: '#ffffff', z: Z.OV_TEXT }))
    texts.push(txt(sec.completeSum === sec.plateCount ? 'COMPLETED!!!' : `${sec.completeSum}/${sec.plateCount}`,
      700, sec.y - 57, 36,
      { font: 'fot', color: sec.color, anchor: 'mm', stroke: 4, strokeColor: '#ffffff', z: Z.OV_TEXT }))
    texts.push(txt(`${pyRound2(pg * 100)}%`, 1190, sec.y - 57, 20,
      { font: 'fot', color: sec.color, anchor: 'rm', stroke: 2, strokeColor: '#ffffff', z: Z.OV_TEXT }))

    for (const cell of sec.cells) {
      if (cell.overflow !== undefined) {
        // 源 multiline_text，仅 20px、无描边、`_default_text_color`
        texts.push(txt(`余「${cell.overflow}」\n个未完成`, cell.x, cell.y + 35, 20,
          { font: 'fot', color: DEFAULT_TEXT_COLOR, anchor: 'lm', multiline: true, z: Z.GRID_IMG }))
        continue
      }
      images.push(img(songChartSrc(cell.song.song_id), cell.x, cell.y, 80, 80, { z: Z.GRID_IMG }))
      images.push(img(picSrc('border_table_base.png'), cell.x - 5, cell.y - 5, null, null, { z: Z.GRID_IMG }))
      // 源此处未给 fill → DrawText 默认白
      texts.push(txt(cell.song.song_id, cell.x + 56, cell.y + 4, 16,
        { font: 'tb', color: '#ffffff', anchor: 'mm', z: Z.BASE_TEXT }))
    }
  }

  texts.push(footerElement(layout.footer, botName))

  return {
    width: 1400,
    height: layout.height,
    scale: 1,
    cssWidth: 1400,
    cssHeight: layout.height,
    pageLeft: 0,
    pageTop: 0,
    bgCss: tricolorGradientCss(),
    card: cardElement(layout.card),
    images,
    texts,
  }
}

// =====================================================================
// 等级进度 / 分数列表（源 core/image/score.py DrawScore）
// =====================================================================

/** 源 _design_text：注意含 `Data from {service}`，与表格族页脚（无数据源子句）不同，勿统一 */
function designText(serviceName, botName) {
  return `Designed by Yuri-YuzuChaN & BlueDeer233. Data from ${serviceName}. Generated by ${botName} BOT`
}

/** 源 DrawScore._while_pic：未游玩谱面网格（20 列、步长 65、曲绘 55、id 12px） */
export function whilePic(images, texts, data, startY = 200) {
  const STEP = 65
  const START_X = 55
  data.forEach((v, num) => {
    const row = Math.floor(num / 20)
    const col = num % 20
    const x = START_X + col * STEP
    const y = startY + row * STEP
    images.push(img(songChartSrc(v.song_id), x, y, 55, 55, { z: Z.GRID_IMG }))
    images.push(img(picSrc(`border_progress_${DIFF_BG_NAMES[v.level_index]}.png`),
      x - 4, y - 4, null, null, { z: Z.GRID_IMG }))
    texts.push(txt(v.song_id, x + 36, y + 3, 12,
      { font: 'tb', color: DIFF_TEXT_COLOR[v.level_index], anchor: 'mm', z: Z.BASE_TEXT }))
  })
}

/** DrawScore 系页面的公共骨架：装饰底（源 DrawScore.__init__ 的 aurora/rainbow/pattern 块） */
function scoreFrame(height) {
  return {
    images: tableBgLayers(height, null),
    texts: [],
    width: 1400,
    height,
    scale: 1,
    cssWidth: 1400,
    cssHeight: height,
    pageLeft: 0,
    pageTop: 0,
    bgCss: tricolorGradientCss(),
    card: null,
  }
}

const designSrc = () => themedPicSrc('prism_plus', 'design.png')
const titleLengthenSrc = () => themedPicSrc('prism_plus', 'title_lengthen.png')

/**
 * 等级进度·三段版（源 score.py:178 DrawScore.draw_plan）
 *
 * ⚠️ 三个列表传**完整数据**，视图按上限截断后才绘制（源在绘制处切片）——
 * 标题上的计数用的是完整长度，两者不可混用。
 *
 * @param {object} o
 * @param {string} o.level 定数
 * @param {string} o.plan 目标（展示时 upper）
 * @param {Array} o.completed / o.unfinished / o.notplayed
 * @param {object} o.heights levelPlanHeights 输出
 * @param {string} o.serviceName / o.botName
 */
export function levelPlanView({ level, plan, completed, unfinished, notplayed, heights, serviceName, botName, cmdHead = 'mai' }) {
  const { cY, uY, compLimit } = heights
  const v = scoreFrame(heights.height)
  const { images, texts } = v
  const D = DEFAULT_TEXT_COLOR
  const planUp = plan.toUpperCase()

  images.push(img(titleLengthenSrc(), 475, 30, null, null, { z: Z.OV_ART }))
  images.push(img(titleLengthenSrc(), 475, 30 + cY, null, null, { z: Z.OV_ART }))
  images.push(img(titleLengthenSrc(), 475, 30 + cY + uY, null, null, { z: Z.OV_ART }))

  // 指导语：源写的是它自己的触发词「{level}{plan}已完成进度」，本插件没有该形态，
  // 故改为指向收编后的真实命令（含可配命令头），避免图里教一个不存在的命令。
  const hint = (cat) => `可使用「#${cmdHead} progress ${level} ${plan} ${cat}」\n指令查询详细列表`

  texts.push(txt(`已完成谱面「${completed.length}」个`, 700, 77, 25,
    { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
  texts.push(txt(hint('已完成'), 1300, 77, 20,
    { font: 'sy', color: D, anchor: 'rm', stroke: 2, strokeColor: '#ffffff', multiline: true, z: Z.OV_TEXT }))
  texts.push(txt(`未完成谱面「${unfinished.length}」个`, 700, 77 + cY, 25,
    { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
  texts.push(txt(hint('未完成'), 1300, 77 + cY, 20,
    { font: 'sy', color: D, anchor: 'rm', stroke: 2, strokeColor: '#ffffff', multiline: true, z: Z.OV_TEXT }))
  texts.push(txt(`未游玩谱面「${notplayed.length}」个`, 700, 77 + cY + uY, 25,
    { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))

  whiledraw(images, texts, completed.slice(0, compLimit), { dx: false, listY: 140 })
  whiledraw(images, texts, unfinished.slice(0, 30), { dx: false, listY: 140 + cY })
  whilePic(images, texts, notplayed.slice(0, 100), 140 + cY + uY)

  images.push(img(designSrc(), 200, heights.height - 133, null, null, { z: Z.OV_ART }))
  const max = completed.length + unfinished.length + notplayed.length
  texts.push(txt(
    `「${level}」共计「${max}」个谱面，剩余「${unfinished.length + notplayed.length}」个谱面未完成「${planUp}」`,
    700, heights.height - 90, 22, { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
  texts.push(txt(designText(serviceName, botName), 700, heights.height - 30, 25,
    { font: 'sy', color: D, anchor: 'mm', stroke: 2, strokeColor: '#ffffff', z: Z.OV_TEXT }))
  return v
}

/**
 * 等级进度·单类别版（源 score.py:282 DrawScore.draw_category）
 * @param {'completed'|'unfinished'|'notplayed'} o.category
 * @param {Array} o.data 完整数据（本函数按页切片；notplayed 支用全量）
 */
export function levelCategoryView({ category, data, heights, serviceName, botName }) {
  const v = scoreFrame(heights.height)
  const { images, texts } = v
  const D = DEFAULT_TEXT_COLOR
  images.push(img(titleLengthenSrc(), 475, 30, null, null, { z: Z.OV_ART }))

  if (category === 'notplayed') {
    texts.push(txt('未游玩谱面', 700, 77, 28, { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
    whilePic(images, texts, data)
    images.push(img(designSrc(), 200, heights.height - 113, null, null, { z: Z.OV_ART }))
    texts.push(txt(`未游玩谱面共计「${data.length}」个`, 700, heights.height - 70, 25,
      { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
    return v
  }

  const label = category === 'completed' ? '已完成' : '未完成'
  const { page, totalPage, display } = heights
  texts.push(txt(`${label}谱面`, 700, 77, 28, { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
  whiledraw(images, texts, display, { dx: false, listY: 140 })
  images.push(img(designSrc(), 200, heights.height - 133, null, null, { z: Z.OV_ART }))
  const from = (page - 1) * 80 + 1
  const to = 80 * (page - 1) + display.length
  texts.push(txt(`${label}谱面共计「${data.length}」个，当前第「${from}-${to}」个，第「${page} / ${totalPage}」页`,
    700, heights.height - 90, 25, { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
  texts.push(txt(designText(serviceName, botName), 700, heights.height - 30, 25,
    { font: 'sy', color: D, anchor: 'mm', stroke: 2, strokeColor: '#ffffff', z: Z.OV_TEXT }))
  return v
}

/**
 * 分数列表（源 score.py:341 DrawScore.draw_score_list）
 * 每 20 条一组、组高 140+4*114，组头 `No.x- No.y`（fot 28）
 */
export function levelScoreListView({ rating, playResult, page = 1, endPage, serviceName, botName }) {
  const heights = levelScoreListLayoutFor(playResult.length, page)
  const v = scoreFrame(heights.height)
  const { images, texts } = v
  const D = DEFAULT_TEXT_COLOR
  const startOffset = (heights.page - 1) * 80
  const current = playResult.slice(startOffset, heights.page * 80)
  const groupHeight = 140 + 4 * 114

  for (let num = 0; num < current.length; num += 20) {
    const idx = num / 20
    const group = current.slice(num, num + 20)
    const baseY = idx * groupHeight
    images.push(img(titleLengthenSrc(), 475, baseY + 20, null, null, { z: Z.OV_ART }))
    texts.push(txt(`No.${startOffset + num + 1}- No.${startOffset + num + group.length}`,
      700, baseY + 67, 28, { font: 'fot', color: D, anchor: 'mm', z: Z.OV_TEXT }))
    whiledraw(images, texts, group, { dx: false, listY: baseY + 140 })
  }

  images.push(img(designSrc(), 200, heights.height - 153, null, null, { z: Z.OV_ART }))
  texts.push(txt(
    `「${rating}」共计「${playResult.length}」个成绩，当前第「${startOffset + 1}-${startOffset + current.length}」个，第「${heights.page} / ${endPage}」页`,
    700, heights.height - 110, 25, { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
  texts.push(txt(designText(serviceName, botName), 700, heights.height - 35, 25,
    { font: 'sy', color: D, anchor: 'mm', stroke: 2, strokeColor: '#ffffff', z: Z.OV_TEXT }))
  return v
}

// =====================================================================
// 上分推荐（源 score.py:61 DrawScore.while_rise_pic + :130 draw_rise）
// =====================================================================

/** 一行推荐（源 while_rise_pic）。⚠️ 参数名与效果**相反**：isdx=True 时画在左侧（源 base_x = 200 if isdx else 700） */
function riseRow(images, texts, data, lowScore, isSd) {
  const baseX = isSd ? 200 : 700
  const START_Y = 120
  const STEP = 140
  data.forEach((d, index) => {
    const x = baseX
    const y = START_Y + index * STEP
    const diffColor = DIFF_TEXT_COLOR[d.level_index]
    const idColor = ID_TEXT_COLOR[d.level_index]

    images.push(img(picSrc(`rise_score_${DIFF_BG_NAMES[d.level_index]}.png`), x + 30, y, null, null, { z: Z.GRID_IMG }))
    images.push(img(songChartSrc(d.song_id), x + 55, y + 41, 80, 80, { z: Z.GRID_IMG }))
    images.push(img(picSrc(`${d.type.toUpperCase()}.png`), x + 240, y + 114, 60, 22, { z: Z.GRID_IMG }))
    if (d.old_rate) {
      // ⚠️ old_rate 与 rate 的取值口径**不同**：`rate` 是小写键（走 RANK_MAP 转展示名），
      // 而 `old_rate` 源是**直接拼进文件名**的。源侧 old_rate = RateType.value（小写）或默认 "D"，
      // 靠 Windows 路径大小写不敏感才命中 _SSS.png —— 在 Linux 上会坏。
      // 这里统一成展示名（`RANK_MAP[key] ?? key`）：Windows 下解析到同一文件、像素完全一致，
      // 同时在大小写敏感的文件系统上也成立；未游玩时的 "D" 不是 RANK_MAP 的键，回退原值即可。
      const oldRateName = RANK_MAP[d.old_rate] ?? d.old_rate
      images.push(img(themedPicSrc('prism_plus', `UI_TTR_Rank_${oldRateName}.png`), x + 145, y + 82, 63, 28, { z: Z.GRID_IMG }))
    }
    images.push(img(themedPicSrc('prism_plus', `UI_TTR_Rank_${RANK_MAP[d.rate]}.png`), x + 305, y + 82, 63, 28, { z: Z.GRID_IMG }))

    let title = d.song_name
    if (coloumWidth(title) > 26) title = changeColumnWidth(title, 25) + '...'
    texts.push(txt(title, x + 142, y + 44, 17, { font: 'sy', color: diffColor, anchor: 'lm', z: Z.BASE_TEXT }))
    texts.push(txt(`ID: ${d.song_id}`, x + 145, y + 124, 18, { font: 'tb', color: idColor, anchor: 'lm', z: Z.BASE_TEXT }))
    texts.push(txt(`${d.old_achievements.toFixed(4)}%`, x + 210, y + 71, 25, { font: 'tb', color: diffColor, anchor: 'mm', z: Z.BASE_TEXT }))
    texts.push(txt(`Ra: ${d.old_rating}`, x + 245, y + 96, 17, { font: 'tb', color: diffColor, anchor: 'mm', z: Z.BASE_TEXT }))
    texts.push(txt(`${d.achievements.toFixed(4)}%`, x + 370, y + 71, 25, { font: 'tb', color: diffColor, anchor: 'mm', z: Z.BASE_TEXT }))
    texts.push(txt(`Ra: ${d.rating}`, x + 415, y + 96, 17, { font: 'tb', color: diffColor, anchor: 'mm', z: Z.BASE_TEXT }))
    texts.push(txt(`ds:${d.level_value}`, x + 315, y + 124, 18, { font: 'tb', color: idColor, anchor: 'lm', z: Z.BASE_TEXT }))
    const newRa = d.old_rating > lowScore ? d.rating - d.old_rating : d.rating - lowScore
    texts.push(txt(`Ra +${newRa}`, x + 390, y + 124, 18, { font: 'tb', color: idColor, anchor: 'lm', z: Z.BASE_TEXT }))
  })
}

/**
 * 上分推荐页（源 score.py:130 draw_rise）
 * 源画布 1400×960，末尾 `im.crop((200, 0, 1200, total_height))` → 输出 1000×960
 */
export function riseView({ sd, sdLow, dx, dxLow, serviceName, botName }) {
  const HEIGHT = 960
  const v = scoreFrame(HEIGHT)
  const { images, texts } = v
  const D = DEFAULT_TEXT_COLOR
  const titleBg = themedPicSrc('prism_plus', 'title.png')

  images.push(img(titleBg, 314, 30, 273, 80, { z: Z.OV_ART }))
  texts.push(txt('旧版本谱面推荐', 450, 68, 18, { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
  riseRow(images, texts, sd, sdLow, true)

  images.push(img(titleBg, 814, 30, 273, 80, { z: Z.OV_ART }))
  texts.push(txt('新版本谱面推荐', 950, 68, 18, { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
  riseRow(images, texts, dx, dxLow, false)

  texts.push(txt('「谱面推荐不使用任何算法，仅供参考」', 700, HEIGHT - 84, 25,
    { font: 'sy', color: D, anchor: 'mm', z: Z.OV_TEXT }))
  texts.push(txt(designText(serviceName, botName), 700, HEIGHT - 36, 18,
    { font: 'sy', color: D, anchor: 'mm', stroke: 2, strokeColor: '#ffffff', z: Z.OV_TEXT }))

  return {
    width: 1400,
    height: HEIGHT,
    scale: 1,
    cssWidth: 1000,   // 源末尾 crop((200,0,1200,h))
    cssHeight: HEIGHT,
    pageLeft: -200,
    pageTop: 0,
    bgCss: tricolorGradientCss(),
    card: null,
    images,
    texts,
  }
}
