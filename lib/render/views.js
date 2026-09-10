/**
 * 页面视图构建器（源 core/image/{best50,info,chart,song,tools}.py → 坐标直译，设计 §8.2/§8.3，ADR-1/9）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN，https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx）
 * 及上游 mai-bot 项目的美术设计，仅作信息级还原复用，相关权利归原作者所有。
 *
 * 约定：源 PIL alpha_composite(im, (x, y)) / DrawText.draw(x, y, size, ...) 的每个调用点
 * 逐一翻译为 images[] / texts[] 绝对定位元素，模板只负责打印——坐标与源逐像素一致。
 * anchor 对应 PIL 文字锚点：lt / lm / rm / mm / ld。
 * ⚠️ 模板必须为该 anchor 备好对应的 .a-xx 规则，否则会**静默退化**成 lt（文字整体下移约一个字高）——
 * 定数/完成表的 `Level.` 标题用的正是 ld（源 rating_table.py:164/185）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { staticRoot } from '../path.js'
import { songChartFile } from './assets.js'
import { mai } from '../service.js'
import { CATEGORY, COMBO_MAP, DIFFS, RANK_MAP, RANK_PLUS, SYNC_MAP } from '../constants.js'
import { dxStar, computeRating } from '../calc.js'
import { changeColumnWidth, coloumWidth, fmtNum, pyFloat, pyRound2 } from './textwidth.js'
import { onlineAssetUrl, qqLogoUrl } from '../client/http.js'
import { ACHIEVEMENT_LIST } from '../constants.js'

// ---- 源 AssetsImage 颜色表直译 ----
export const DIFF_TEXT_COLOR = ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#8a00e2']
export const ID_TEXT_COLOR = ['#81d955', '#f5bd15', '#ff818d', '#9f51dc', '#8a00e2']
export const DEFAULT_TEXT_COLOR = '#7c81ff'
export const THEME_COLOR = { prism_plus: '#7c81ff', circle: '#f93eac' }
const BLACK = '#000000'
const WHITE = '#ffffff'

/** static/mai/pic 下切图 → file:// URL（空格转 %20） */
export function picSrc(...names) {
  const p = path.join(staticRoot, 'mai', 'pic', ...names)
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}`
}

/** 主题切图 pic/<theme>/xxx.png */
export function themedPicSrc(theme, name) {
  return picSrc(theme, name)
}

/** static/mai/<dir>/xxx.png（牌子版本图等） */
export function maiSrc(dir, name) {
  const p = path.join(staticRoot, 'mai', dir, name)
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}`
}

/** 源 song_chart：id % 10000 曲绘，缺图回退 0.png（路径口径见 render/assets.js:songChartFile） */
export function songChartSrc(songId) {
  return `file:///${songChartFile(songId).replace(/\\/g, '/').replace(/ /g, '%20')}`
}

/** 收藏品在线切图（源 _fetch_image：UI_Plate_000123.png / UI_Icon_000123.png） */
function collectionSrc(type, id) {
  return onlineAssetUrl(`/${type}/UI_${type[0].toUpperCase()}${type.slice(1)}_${String(id).padStart(6, '0')}.png`)
}

export const DIFF_BG_NAMES = ['basic', 'advanced', 'expert', 'master', 'remaster']

/**
 * 图片元素（w/h 为 null 时按原始尺寸显示；z 默认 1，模板不再兜底）
 * extra 可含 z（叠层次序）与 crop:true（object-fit:none 按宽裁剪，源 Image.crop 直译）
 */
export function img(src, x, y, w = null, h = null, extra = {}) {
  return { src, x, y, w, h, z: 1, ...extra }
}

/**
 * 文字元素（z 默认 3，模板不再兜底）
 * multiline:true 对应源 PIL multiline_text —— 文本内的 \n 生效（white-space:pre-line）
 */
export function txt(text, x, y, size, { font = 'sy', color = WHITE, anchor = 'lt', stroke = 0, strokeColor = WHITE, z = 3, multiline = false } = {}) {
  // PIL stroke_width + stroke_fill → 8 向 text-shadow（外描边近似）
  let shadow = ''
  if (stroke > 0) {
    const w = stroke
    const c = strokeColor
    const d = Math.round(w * 0.7 * 10) / 10
    shadow = [
      `-${w}px 0 0 ${c}`, `${w}px 0 0 ${c}`, `0 -${w}px 0 ${c}`, `0 ${w}px 0 ${c}`,
      `-${d}px -${d}px 0 ${c}`, `${d}px -${d}px 0 ${c}`, `-${d}px ${d}px 0 ${c}`, `${d}px ${d}px 0 ${c}`,
    ].join(', ')
  }
  return { text: String(text), x, y, size, font, color, anchor, stroke, z, shadow, multiline }
}

/** PRiSM PLUS 三色渐变背景（源 tricolor_gradient_prism_plus，t 自底向上） */
export function tricolorGradientCss() {
  const stops = [
    ['#65f2df', 0], ['#65f2df', 5], ['#72bcfe', 15], ['#eaabff', 33],
    ['#ffc5d5', 44], ['#ffd5cf', 54], ['#ffd5cf', 76], ['#ffffff', 86], ['#ffffff', 100],
  ]
  return `linear-gradient(to bottom, ${stops.map(([c, p]) => `${c} ${p}%`).join(', ')})`
}

// =====================================================================
// 成绩格网格（源 core/image/base.py:95 ScoreBaseImage.whiledraw）
// 5 列 × 无限行，每格 276×114（起点 16）。b50 / 等级进度 / 分数列表现场共用。
// =====================================================================

/**
 * @param {Array} images 输出图片元素数组（原地追加）
 * @param {Array} texts 输出文字元素数组（原地追加）
 * @param {Array} data PlayedResult[]
 * @param {object} [opts]
 * @param {boolean} [opts.dx] 源 dx 形参：仅当 listY===0 时决定起始 y（DX 区 1085 / SD 区 235）
 * @param {number} [opts.listY] 源 list_y：非 0 时直接作为起始 y（进度/列表页传 140 等）
 * @param {string} [opts.theme] 主题（评级图标取 pic/<theme>/）
 */
export function whiledraw(images, texts, data, { dx = false, listY = 0, theme = 'prism_plus' } = {}) {
  const gapY = 114
  const dxStep = 276
  const startX = 16
  const initialY = listY === 0 ? (dx ? 1085 : 235) : listY
  data.forEach((info, num) => {
    const row = Math.floor(num / 5)
    const col = num % 5
    const x = startX + col * dxStep
    const y = initialY + row * gapY
    const li = info.level_index

    images.push(img(picSrc(`b50_score_${DIFF_BG_NAMES[li]}.png`), x, y))
    images.push(img(songChartSrc(info.song_id), x + 12, y + 12, 75, 75))
    images.push(img(picSrc(`${info.type.toUpperCase()}.png`), x + 51, y + 91, 37, 14))
    if (info.rate) {
      const rateName = info.rate === info.rate.toLowerCase() ? RANK_MAP[info.rate] : info.rate
      if (rateName) images.push(img(themedPicSrc(theme, `UI_TTR_Rank_${rateName}.png`), x + 92, y + 78, 63, 28))
    }
    if (info.fc) images.push(img(picSrc(`UI_MSS_MBase_Icon_${COMBO_MAP[info.fc]}.png`), x + 154, y + 77, 34, 34))
    if (info.fs) images.push(img(picSrc(`UI_MSS_MBase_Icon_${SYNC_MAP[info.fs]}.png`), x + 185, y + 77, 34, 34))

    const song = mai.totalList.byId(info.song_id)
    const dxMax = song?.difficulties?.[li]?.dx_score ?? 0
    const star = dxMax > 0 ? dxStar((info.dx_score / dxMax) * 100) : 0
    if (star !== 0) {
      images.push(img(picSrc(`UI_GAM_Gauge_DXScoreIcon_0${star}.png`), x + 217, y + 80, 47, 26))
    }

    texts.push(txt(info.song_id, x + 26, y + 98, 13, { font: 'tb', color: ID_TEXT_COLOR[li], anchor: 'mm' }))
    let title = info.song_name
    if (coloumWidth(title) > 18) title = changeColumnWidth(title, 17) + '...'
    texts.push(txt(title, x + 93, y + 14, 14, { font: 'sy', color: DIFF_TEXT_COLOR[li], anchor: 'lm' }))
    texts.push(txt(`${info.achievements.toFixed(4)}%`, x + 93, y + 38, 30, { font: 'tb', color: DIFF_TEXT_COLOR[li], anchor: 'lm' }))
    texts.push(txt(`${info.dx_score}/${dxMax}`, x + 219, y + 65, 15, { font: 'tb', color: DIFF_TEXT_COLOR[li], anchor: 'mm' }))
    const ds = mai.totalLevelValueMap[`${info.song_id}-${li}`]
    texts.push(txt(`${pyFloat(ds)} -> ${info.rating}`, x + 93, y + 65, 15, { font: 'tb', color: DIFF_TEXT_COLOR[li], anchor: 'lm' }))
  })
}

// =====================================================================
// B50（源 best50.py PlayerBest50 + base.py whiledraw，画布 1400×1600）
// =====================================================================

function findRaPic(rating, theme) {
  const thresholds = [[1000, '01'], [2000, '02'], [4000, '03'], [7000, '04'], [10000, '05'],
    [12000, '06'], [13000, '07'], [14000, '08'], [14500, '09'], [15000, '10']]
  for (const [limit, num] of thresholds) {
    if (rating < limit) return `UI_CMN_DXRating_${num}.png`
  }
  let num = '11'
  if (theme === 'circle') {
    if (rating < 16000) num = '11'
    else if (rating < 17000) num = '12'
    else num = '11'
  }
  return `UI_CMN_DXRating_${num}.png`
}

function raPicStar(rating) {
  const thresholds = [14000, 14250, 14500, 14750, 15000, 15250, 15500, 15750, 16000, 16250, 16500, 16750]
  const numMap = [1, 2, 1, 2, 1, 2, 3, 4, 1, 2, 3, 4]
  let idx = 0
  while (idx < thresholds.length && rating >= thresholds[idx]) idx++
  idx -= 1
  // 源 bisect_right(thresholds, rating) - 1：rating < 14000 时为 -1，此时源会取负下标（实际不会发生：星标仅 ≥14000 绘制）
  return `UI_CMN_DXRating_Star_0${numMap[idx]}.png`
}

/**
 * @param {object} opts
 * @param {string} opts.theme prism_plus | circle
 * @param {number|null} opts.qqid 查询目标 QQ（QQ 头像）
 * @param {object} opts.player Player
 * @param {object} opts.best50 Best50
 * @param {string} opts.serviceName Data from xxx
 * @param {string} opts.botName
 */
export function b50View({ theme = 'prism_plus', qqid = null, player, best50, serviceName, botName }) {
  const images = []
  const texts = []
  const color = THEME_COLOR[theme] || THEME_COLOR.prism_plus

  // logo
  images.push(img(themedPicSrc(theme, 'logo.png'), 14, 60, 249, 120))

  // plate
  let plateSrc
  if (!player.name_plate) {
    plateSrc = picSrc('UI_Plate_550101.png')
  } else if (typeof player.name_plate === 'object') {
    plateSrc = collectionSrc('plate', player.name_plate.id)
  } else {
    plateSrc = maiSrc('plate_version', `${player.name_plate}.png`)
  }
  images.push(img(plateSrc, 300, 60, 800, 130, { fallback: picSrc('UI_Plate_550101.png') }))

  // icon
  let iconSrc
  if (player.icon) {
    iconSrc = collectionSrc('icon', player.icon.id)
  } else if (qqid) {
    iconSrc = qqLogoUrl(qqid)
  } else {
    iconSrc = picSrc('UI_Icon_509506.png')
  }
  images.push(img(iconSrc, 305, 65, 120, 120, { fallback: picSrc('UI_Icon_509506.png') }))

  // dx_rating
  let dxW = 186
  let numX = 520
  let numY = 80
  let gap = 15
  let numW = 17
  let numH = 20
  if (theme === 'circle' && player.rating >= 14000) {
    dxW = 170
    images.push(img(themedPicSrc(theme, raPicStar(player.rating)), 590, 72, 21, 35))
    numX = 515
    numY = 82
    gap = 13
    numW = 14
    numH = 17
  }
  images.push(img(themedPicSrc(theme, findRaPic(player.rating, theme)), 435, 72, dxW, 35))

  // rating 逐位数字图
  const digits = String(player.rating).padStart(5, '0')
  for (let n = 0; n < digits.length; n++) {
    images.push(img(picSrc(`UI_NUM_Drating_${digits[n]}.png`), numX + gap * n, numY, numW, numH))
  }
  images.push(img(picSrc('Name.png'), 435, 115))
  const cr = player.course_rank ?? 0
  const crNum = String(cr <= 10 ? cr : cr + 1).padStart(2, '0')
  images.push(img(picSrc(`UI_DNM_DaniPlate_${crNum}.png`), 625, 120, 80, 32))
  images.push(img(picSrc(`UI_FBR_Class_${String(player.class_rank ?? 0).padStart(2, '0')}.png`), 620, 60, 90, 54))

  // trophy / 称号框
  let trophyTitle
  let trophyFont
  let shougouColor
  if (player.trophy) {
    trophyTitle = player.trophy.name
    trophyFont = 'sy'
    shougouColor = player.trophy.color || 'Rainbow'
  } else {
    trophyTitle = `B35: ${best50.sd_total} + B15: ${best50.dx_total} = ${player.rating}`
    trophyFont = 'tb'
    shougouColor = 'Rainbow'
  }
  images.push(img(maiSrc('shougou', `UI_CMN_Shougou_${shougouColor}.png`), 435, 160, 270, 27))
  texts.push(txt(trophyTitle, 570, 172, 14, { font: trophyFont, color: BLACK, anchor: 'mm' }))

  // 玩家名
  texts.push(txt(player.name, 445, 135, 20, { font: 'sy', color: BLACK, anchor: 'lm' }))
  // 页脚
  texts.push(txt(
    `Designed by Yuri-YuzuChaN & BlueDeer233. Data from ${serviceName}. Generated by ${botName} BOT`,
    700, 1570, 22, { font: 'sy', color, anchor: 'mm', stroke: 5, strokeColor: WHITE }
  ))

  // 成绩格（源 whiledraw）
  whiledraw(images, texts, best50.sd, { dx: false, theme })
  whiledraw(images, texts, best50.dx, { dx: true, theme })

  return {
    width: 1400,
    height: 1600,
    bg: themedPicSrc(theme, 'b50.png'),
    images,
    texts,
  }
}

// =====================================================================
// 单曲成绩卡（源 info.py song_play_data，画布 1200×900）
// =====================================================================

/**
 * @param {object} opts
 * @param {string} opts.theme
 * @param {object} opts.song Song
 * @param {Array} opts.playResult PlayedResult | NotPlayedResult 混合列表
 * @param {string} opts.serviceName
 * @param {string} opts.botName
 */
export function playDataView({ theme = 'prism_plus', song, playResult, serviceName, botName }) {
  const images = []
  const texts = []
  const color = THEME_COLOR[theme] || THEME_COLOR.prism_plus

  images.push(img(themedPicSrc(theme, 'logo.png'), 42, 34, 249, 120))
  images.push(img(songChartSrc(song.song_id), 100, 260, 300, 300))
  images.push(img(picSrc(`info_${CATEGORY[song.genre] || 'game'}.png`), 100, 260))
  images.push(img(picSrc(`${song.version_str}.png`), 295, 205, 183, 90))
  images.push(img(picSrc(`${song.type}.png`), 350, 560, 55, 20))

  texts.push(txt(`Data from ${serviceName}`, 1140, 737, 18, { font: 'tb', color, anchor: 'rm' }))

  let artist = song.artist
  if (coloumWidth(artist) > 58) artist = changeColumnWidth(artist, 57) + '...'
  texts.push(txt(artist, 255, 595, 12, { font: 'sy', color, anchor: 'mm' }))

  let songName = song.song_name
  if (coloumWidth(songName) > 38) songName = changeColumnWidth(songName, 37) + '...'
  texts.push(txt(songName, 255, 622, 18, { font: 'sy', color, anchor: 'mm' }))
  texts.push(txt(song.song_id, 160, 720, 22, { font: 'fot', color, anchor: 'mm' }))
  // 源 str(float) 语义：150.0 显示 "150.0"（py bpm 字段恒为 float）
  texts.push(txt(fmtNum(song.bpm), 380, 720, 22, { font: 'fot', color, anchor: 'mm' }))

  const y = 100
  playResult.forEach((info, num) => {
    images.push(img(picSrc(`d_${num}.png`), 650, 235 + y * num))
    if (!info.notPlayed) {
      images.push(img(themedPicSrc(theme, 'ra_dx.png'), 850, 272 + y * num, 102, 44))
      const dxMax = song.difficulties[num]?.dx_score ?? 0
      const dxnum = dxMax > 0 ? dxStar((info.dx_score / dxMax) * 100) : 0
      if (dxnum !== 0) {
        images.push(img(picSrc(`UI_GAM_Gauge_DXScoreIcon_0${dxnum}.png`), 851, 296 + y * num, 32, 19))
      }
      texts.push(txt(`${info.dx_score}/${dxMax}`, 916, 304 + y * num, 13, { font: 'tb', color, anchor: 'mm' }))

      images.push(img(picSrc('fcfs.png'), 965, 265 + y * num))
      if (info.fc) {
        images.push(img(picSrc(`UI_CHR_PlayBonus_${COMBO_MAP[info.fc]}.png`), 960, 261 + y * num, 65, 65))
      }
      if (info.fs) {
        images.push(img(picSrc(`UI_CHR_PlayBonus_${SYNC_MAP[info.fs]}.png`), 1025, 261 + y * num, 65, 65))
      }
      const rateName = info.rate ? RANK_MAP[info.rate] : null
      if (rateName) {
        images.push(img(themedPicSrc(theme, `UI_TTR_Rank_${rateName}.png`), 737, 272 + y * num, 100, 45))
      }
      texts.push(txt(`${info.achievements.toFixed(4)}%`, 500, 295 + y * num, 30, { font: 'fot', color, anchor: 'lm' }))
      texts.push(txt(pyFloat(info.level_value), 685, 248 + y * num, 20, { font: 'fot', color: WHITE, anchor: 'mm' }))
      texts.push(txt(info.rating, 915, 283 + y * num, 18, { font: 'tb', color, anchor: 'mm' }))
    } else {
      texts.push(txt(pyFloat(info.level_value), 685, 248 + y * num, 25, { font: 'fot', color: WHITE, anchor: 'mm' }))
      texts.push(txt('未游玩', 800, 302 + y * num, 30, { font: 'sy', color, anchor: 'mm' }))
    }
  })
  if (playResult.length === 4) {
    texts.push(txt('没有该难度', 800, 302 + y * 4, 30, { font: 'sy', color, anchor: 'mm' }))
  }

  texts.push(txt(
    `Designed by Yuri-YuzuChaN & BlueDeer233. Generated by ${botName} BOT`,
    600, 830, 25, { font: 'sy', color, anchor: 'mm', stroke: 3, strokeColor: WHITE }
  ))

  return {
    width: 1200,
    height: 900,
    bg: themedPicSrc(theme, 'play_info.png'),
    images,
    texts,
  }
}

// =====================================================================
// 谱面信息卡（源 chart.py song_chart_info 1200×1300 / song_chart_banquet_info 1200×1200）
// =====================================================================

const NOTE_FIELDS = ['total', 'tap', 'hold', 'slide', 'touch', 'brk']

function getBestRating(rating) {
  const tail = ACHIEVEMENT_LIST.slice(-6)
  const ra = tail.map(r => computeRating(rating, r))
  ra.push(computeRating(rating, ACHIEVEMENT_LIST[ACHIEVEMENT_LIST.length - 1]) + 1)
  ra.sort((a, b) => b - a)
  return ra
}

function newBestScore(songId, levelIndex, value, bestList) {
  for (const v of bestList) {
    if (songId === v.song_id && levelIndex === v.level_index) {
      return value >= v.rating ? value - v.rating : 0
    }
  }
  return value - bestList[bestList.length - 1].rating
}

/**
 * @param {object} opts
 * @param {object} opts.song Song
 * @param {boolean} opts.calc 是否带入个人 B50 计算
 * @param {boolean} opts.isFull b35/b15 是否已满
 * @param {Array} opts.bestList PlayedResult[]
 * @param {string} opts.theme
 * @param {string} opts.botName
 */
export function chartInfoView({ song, calc = false, isFull = false, bestList = [], theme = 'prism_plus', botName }) {
  const images = []
  const texts = []
  const color = THEME_COLOR[theme] || THEME_COLOR.prism_plus

  images.push(img(themedPicSrc(theme, 'logo.png'), 65, 25, 249, 120))
  if (song.isnew) {
    images.push(img(picSrc('UI_CMN_TabTitle_NewSong.png'), 842, 100, 249, 120))
  }
  images.push(img(songChartSrc(song.song_id), 133, 197, 242, 242))
  images.push(img(picSrc(`${song.version_str}.png`), 800, 370, 182, 90))
  images.push(img(picSrc(`${song.type}.png`), 295, 410, 80, 30))

  let title = song.song_name
  if (coloumWidth(title) > 40) title = changeColumnWidth(title, 39) + '...'
  texts.push(txt(title, 405, 220, 28, { font: 'fot', color, anchor: 'lm' }))

  let artist = song.artist
  if (coloumWidth(artist) > 50) artist = changeColumnWidth(artist, 49) + '...'
  texts.push(txt(artist, 407, 265, 20, { font: 'fot', color, anchor: 'lm' }))
  texts.push(txt(fmtNum(song.bpm), 460, 345, 24, { font: 'fot', color, anchor: 'lm' }))
  texts.push(txt(`ID ${song.song_id}`, 405, 435, 22, { font: 'fot', color, anchor: 'lm' }))
  texts.push(txt(song.genre, 665, 435, 24, { font: 'sy', color, anchor: 'mm' }))

  song.difficulties.forEach((v, index) => {
    const spacing = 70 * index
    texts.push(txt(`${v.level}(${pyFloat(v.level_value)})`, 120, 590 + spacing, 22, { font: 'fot', color: WHITE, anchor: 'mm' }))
    const fitting = v.stats ? `擬 - ${pyRound2(v.stats.fit_diff)}` : '-'
    texts.push(txt(fitting, 120, 613 + spacing, 15, { font: 'fot', color: WHITE, anchor: 'mm' }))
    let designer = v.note_designer
    if (coloumWidth(designer) > 19) designer = changeColumnWidth(designer, 18) + '...'
    texts.push(txt(designer, 310, 590 + spacing, 20, { font: 'sy', color, anchor: 'mm' }))
    NOTE_FIELDS.forEach((field, n) => {
      texts.push(txt(v.notes[field], 480 + 122 * n, 590 + spacing, 25, { font: 'fot', color, anchor: 'mm' }))
    })

    if (index > 1) {
      const ra = getBestRating(v.level_value)
      ra.forEach((value, n) => {
        let size = 22
        let rating = value
        if (!calc) {
          rating = value
        } else if (!isFull) {
          size = 17
          rating = `${value}(↑${value})`
        } else if (value > bestList[bestList.length - 1].rating) {
          const rise = newBestScore(song.song_id, index, value, bestList)
          if (rise === 0) {
            rating = value
          } else {
            size = 17
            rating = `${value}(↑${rise})`
          }
        } else {
          rating = value
        }
        texts.push(txt(rating, 295 + 125 * n, 1017 + 46 * (index - 2), size, { font: 'fot', color, anchor: 'mm' }))
      })
    }
  })
  texts.push(txt('*未实装', 295, 985, 12, { font: 'sy', color: WHITE, anchor: 'mm' }))
  texts.push(txt(
    `Designed by Yuri-YuzuChaN & BlueDeer233. Generated by ${botName} BOT`,
    600, 1220, 25, { font: 'fot', color, anchor: 'mm', stroke: 3, strokeColor: WHITE }
  ))

  return {
    width: 1200,
    height: 1300,
    bg: themedPicSrc(theme, 'chart_info.png'),
    images,
    texts,
  }
}

/** 宴会场谱面卡（源 song_chart_banquet_info，无主题化，紫描边） */
export function chartInfoBanquetView({ song, botName }) {
  const images = []
  const texts = []
  const strokeColor = '#d239ae'

  const isBuddy = Boolean(song.is_buddy)
  images.push(img(picSrc('utg_kanji.png'), 140, isBuddy ? 660 : 730))

  const pY = isBuddy ? 715 : 785
  const baseY = isBuddy ? 820 : 890
  const stepY = isBuddy ? 100 : 0
  images.push(img(picSrc(isBuddy ? 'utg_2p.png' : 'utg_1p.png'), 98, pY))
  if (isBuddy) {
    images.push(img(picSrc('utg_buddy.png'), 255, 660))
  }

  images.push(img(themedPicSrc('prism_plus', 'logo.png'), 10, 35, 249, 120))
  if (song.isnew) {
    images.push(img(picSrc('UI_CMN_TabTitle_NewSong.png'), 950, 165, 249, 120))
  }
  images.push(img(songChartSrc(song.song_id), 133, 246, 242, 242))
  images.push(img(picSrc(`${song.version_str}.png`), 800, 415, 182, 90))

  texts.push(txt(song.kanji, 216, pY - 28, 18, { font: 'fot', color: WHITE, anchor: 'mm', stroke: 3, strokeColor }))
  let title = song.song_name
  if (coloumWidth(title) > 36) title = changeColumnWidth(title, 35) + '...'
  texts.push(txt(title, 405, 265, 28, { font: 'fot', color: WHITE, anchor: 'lm', stroke: 3, strokeColor }))
  let artist = song.artist
  if (coloumWidth(artist) > 50) artist = changeColumnWidth(artist, 49) + '...'
  texts.push(txt(artist, 407, 320, 20, { font: 'fot', color: WHITE, anchor: 'lm', stroke: 3, strokeColor }))
  texts.push(txt(fmtNum(song.bpm), 460, 393, 24, { font: 'fot', color: WHITE, anchor: 'lm', stroke: 3, strokeColor }))
  texts.push(txt(`ID ${song.song_id}`, 405, 475, 22, { font: 'fot', color: WHITE, anchor: 'lm', stroke: 3, strokeColor }))
  texts.push(txt(song.genre, 680, 475, 22, { font: 'fot', color: WHITE, anchor: 'mm', stroke: 3, strokeColor }))
  texts.push(txt(song.description, 595, 595, 25, { font: 'fot', color: WHITE, anchor: 'mm' }))
  texts.push(txt(`Lv. ${song.difficulties[0].level}`, 180, pY + 28, 24, { font: 'fot', color: WHITE, anchor: 'mm', stroke: 3, strokeColor }))
  song.difficulties.forEach((v, index) => {
    NOTE_FIELDS.forEach((field, n) => {
      texts.push(txt(v.notes[field], 330 + 140 * n, baseY + stepY * index, 25, { font: 'fot', color: WHITE, anchor: 'mm', stroke: 3, strokeColor }))
    })
  })
  texts.push(txt(
    `Designed by Yuri-YuzuChaN & BlueDeer233. Generated by ${botName} BOT`,
    600, 1100, 25, { font: 'fot', color: strokeColor, anchor: 'mm', stroke: 3, strokeColor: WHITE }
  ))

  return {
    width: 1200,
    height: 1200,
    bg: picSrc('chart_info_enkaijou.png'),
    images,
    texts,
  }
}

// =====================================================================
// 曲目列表（源 song.py song_list，1000×自适应，PRiSM 渐变底 + 毛玻璃卡）
// =====================================================================

const SONG_PAGE_SIZE = 14

/**
 * @param {Array} songs Song[]（已分页）
 * @param {number} page 当前页
 * @param {number} totalPage 总页数
 * @param {string} opts.botName
 */
export function songListView({ songs, page, totalPage, botName }) {
  const images = []
  const texts = []

  const lines = Math.floor(songs.length / 2) + (songs.length % 2)
  const height = 200 + lines * 145 + 200

  // 背景装饰层（z=0，毛玻璃卡 z=1，内容默认 z=2）
  images.push({ ...img(picSrc('aurora.png'), 0, 0, 1000, 174), z: 0 })
  images.push({ ...img(picSrc('bg_shines.png'), 0, 0, 1000, 442), z: 0 })
  for (let h = 0; h < Math.floor(height / 256) + 1; h++) {
    images.push({ ...img(picSrc('pattern.png'), 0, (256 + 6) * h, 1000, 256), z: 0 })
  }
  images.push({ ...img(picSrc('rainbow.png'), 225, height - 435, 550, 288), z: 0 })
  images.push({ ...img(picSrc('rainbow_bottom.png'), 107, height - 260, 786, 164), z: 0 })

  // 毛玻璃卡（frosted card 区域）
  const card = { x: 50, y: 150, w: 900, h: lines * 145 + 100 }

  images.push({ ...img(themedPicSrc('prism_plus', 'chara_left.png'), 800, 0, 156, 187), z: 2 })
  images.push({ ...img(picSrc('moon.png'), 60, 20, 120, 120), z: 2 })
  images.push({ ...img(picSrc('maimai でらっくす PRiSM PLUS.png'), 15, 20, 210, 101), z: 2 })

  const xGap = 450
  const yGap = 145
  const startX = 70
  const startY = 200
  songs.forEach((song, num) => {
    const row = Math.floor(num / 2)
    const col = num % 2
    const x = startX + col * xGap
    const y = startY + row * yGap

    // 内容图 z=2：压过毛玻璃卡（z=1）但低于文字（z=3）
    images.push(img(picSrc('song_card.png'), x, y, null, null, { z: 2 }))
    images.push(img(songChartSrc(song.song_id), x + 10, y + 10, 80, 80, { z: 2 }))
    images.push(img(picSrc(`${song.version_str}.png`), x + 315, y - 30, 104, 50, { z: 2 }))
    images.push(img(picSrc(song.song_id > 100000 ? 'sl_diff_utg.png' : 'sl_diff.png'), x + 100, y + 95, null, null, { z: 2 }))
    images.push(img(picSrc(`${song.type.toUpperCase()}.png`), x + 50, y + 75, 40, 15, { z: 2 }))

    texts.push(txt(song.song_id, x + 50, y + 105, 15, { font: 'fot', color: DEFAULT_TEXT_COLOR, anchor: 'mm' }))
    let title = song.song_name
    if (coloumWidth(title) > 20) title = changeColumnWidth(title, 19) + '...'
    texts.push(txt(title, x + 100, y + 25, 20, { font: 'fot', color: DEFAULT_TEXT_COLOR, anchor: 'lm' }))
    let artist = song.artist
    if (coloumWidth(artist) > 26) artist = changeColumnWidth(artist, 25) + '...'
    texts.push(txt(artist, x + 100, y + 50, 12, { font: 'fot', color: DEFAULT_TEXT_COLOR, anchor: 'lm' }))
    texts.push(txt(`BPM: ${fmtNum(song.bpm)}`, x + 100, y + 80, 15, { font: 'fot', color: DEFAULT_TEXT_COLOR, anchor: 'lm' }))
    texts.push(txt(song.genre, x + 230, y + 80, 12, { font: 'sy', color: DEFAULT_TEXT_COLOR, anchor: 'lm' }))
    if (song.song_id > 100000) {
      const diff = song.difficulties[0]
      texts.push(txt(pyFloat(diff.level_value), x + 125 + 50 * diff.level_index, y + 105, 15, { font: 'fot', color: WHITE, anchor: 'mm' }))
    } else {
      for (const diff of song.difficulties) {
        texts.push(txt(pyFloat(diff.level_value), x + 125 + 50 * diff.level_index, y + 105, 15, {
          font: 'fot', color: diff.level_index !== 4 ? WHITE : '#8a00e2', anchor: 'mm',
        }))
      }
    }
  })

  texts.push(txt('曲目列表', 500, 70, 55, { font: 'fot', color: DEFAULT_TEXT_COLOR, anchor: 'mm', stroke: 3, strokeColor: WHITE }))
  texts.push(txt(`Page ${page}/${totalPage}`, 500, height - 100, 35, { font: 'fot', color: DEFAULT_TEXT_COLOR, anchor: 'mm', stroke: 3, strokeColor: WHITE }))
  texts.push(txt(
    `Designed by Yuri-YuzuChaN & BlueDeer233. Generated by ${botName} BOT`,
    500, height - 30, 18, { font: 'fot', color: DEFAULT_TEXT_COLOR, anchor: 'mm', stroke: 3, strokeColor: WHITE }
  ))

  return {
    width: 1000,
    height,
    bgCss: tricolorGradientCss(),
    card,
    images,
    texts,
  }
}

/** 曲目列表分页参数（源 song_list 内部分页逻辑） */
export function songListPaging(total, page) {
  const totalPage = Math.max(1, Math.ceil(total / SONG_PAGE_SIZE))
  const p = Math.max(1, Math.min(page, totalPage))
  const start = (p - 1) * SONG_PAGE_SIZE
  return { page: p, totalPage, slice: [start, start + SONG_PAGE_SIZE] }
}

// =====================================================================
// 全服统计饼图（源 chart.py song_global_data → ECharts，1000×800）
// =====================================================================

/**
 * @param {object} opts
 * @param {object} opts.song Song
 * @param {number} opts.levelIndex
 */
export function globalDataView({ song, levelIndex }) {
  const stats = song.difficulties[levelIndex].stats
  // 源：[""] + COMBO_PLUS → 首项空串标签为 "Not FC"，其余大写
  const fcLabels = ['Not FC', ...COMBO_PLUS_ARR()]
  const fcData = fcLabels.map((name, i) => ({ name, value: stats.fc_dist[i] ?? 0 }))
  const accData = RANK_PLUS.map((s, i) => ({ name: s.toUpperCase(), value: stats.dist[i] ?? 0 }))

  const text = [
    `游玩次数：${Math.round(stats.cnt)}`,
    `拟合难度：${stats.fit_diff.toFixed(2)}`,
    `平均达成率：${stats.avg.toFixed(2)}%`,
    `平均 DX 分数：${stats.avg_dx.toFixed(1)}`,
    `谱面成绩标准差：${stats.std_dev.toFixed(2)}`,
  ].join('\n')

  return {
    width: 1000,
    height: 800,
    title: `${song.song_id} ${song.song_name} 「${DIFFS[levelIndex]}」`,
    fcData,
    accData,
    text,
  }
}

function COMBO_PLUS_ARR() {
  // 源 COMBO_PLUS = ["fc", "fc+", "ap", "ap+"]，大写后 FC/FC+/AP/AP+
  return ['FC', 'FC+', 'AP', 'AP+']
}
