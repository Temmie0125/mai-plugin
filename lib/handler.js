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
import { MusicNotPlayError, NotMusicRecommendationError } from './client/errors.js'
import * as database from './database.js'
import { effectiveService } from './user.js'
import { Player, serviceDisplay } from './merge/models.js'
import { dfToBest50, dfToPlayer, lxnsToBest50 } from './merge/player.js'
import { dfToPlayresult, lxnsToPlayresult } from './merge/playResult.js'
import { handleErrors } from './handlerError.js'
import {
  b50View, playDataView, chartInfoView, chartInfoBanquetView,
  songListView, songListPaging, globalDataView, voteListView,
  songChartSrc, dxStarIcon, DIFF_BG_NAMES,
} from './render/views.js'
import {
  renderBest50, renderPlayData, renderChartInfo, renderSongList, renderGlobalData,
  renderPanel, renderVoteList, renderFsline, botName,
} from './render/picmodle.js'
import { computeFsline } from './fsline.js'
import { ratingTableView, plateTableView } from './render/tableViews.js'
import { levelCategoryView, levelPlanView, levelScoreListView, plateProgressView, riseView } from './render/scoreViews.js'
import {
  PLAN_MAP, getRiseScoreList, processLevelProgress, processLevelScoreList, processPlateTable,
  processRatingTableData,
} from './tableData.js'
import { levelPlanHeights, levelScoreListLayout } from './tableLayout.js'
import {
  ACHIEVEMENT_LIST, CATEGORY, COMBO_PLUS, COMBO_SP, DIFFS, RANK_PLUS, SYNC_D_SP, SYNC_PLUS,
  SYNC_SP, VERSION_MAP,
} from './constants.js'
import Config from './config.js'
import { pyFloat } from './render/textwidth.js'

/** 源 handler.py MESSAGE（图后附言） */
export const MESSAGE = '可使用「#mai theme」指令更换主题，「#mai source」指令更换指定查分器。'

/** openid 环境（官方 QQBot 无 QQ 号）下水鱼按 QQ 代查不可用时的引导文案 */
export const DF_QQ_HINT =
  '水鱼查分器需要 QQ 号进行绑定与代查（当前官方QQBot 环境仅提供 openid）。\n' +
  '※ 发送「#mai bind qq <你的QQ号>」补充游戏 QQ 后可解锁水鱼功能；\n' +
  '也可使用「#mai b50 <水鱼用户名>」以用户名查询，或发送「#mai bind lxns」切换落雪数据源。'

/**
 * 别名申请/投票的 openid 兜底引导
 * 柚子服务端把 `agree_user`/`apply_uid` 当**整数 QQ** 校验（实测官方 QQBot 环境下发 openid
 * 会 422 `int_parsing`），故与 `#mai bind qq` 补充的 `qqid` 复用同一条路。
 */
export const ALIAS_QQ_HINT =
  '别名申请与投票在柚子服务器按 QQ 号记录（当前官方QQBot 环境仅提供 openid）。\n' +
  '※ 发送「#mai bind qq <你的QQ号>」补充游戏 QQ 后即可参与。'

/** user 行内是否可作水鱼 QQ 凭据（纯数字 QQ 环境） */
function hasNumericQq(user) {
  return Number.isInteger(user?.qqid) && user.qqid > 0
}

export { hasNumericQq }

// getRows 已下沉到 lib/tableLayout.js（纯几何，便于单测）；此处转出以保持既有导出面
export { getRows } from './tableLayout.js'
export { PLAN_MAP } from './tableData.js'

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

/**
 * 获取游玩成绩全量（源 handler.py:170 get_player_result）
 *
 * ⚠️ 与源的差异：源按 `user.service` 精确分支，此处走 `effectiveService(user)`——
 * 本插件要覆盖 openid/QQ 双协议（openid 环境 user.service 可能未写而实际应走落雪），
 * 与 drawBest50 / drawPlayData 既有口径保持一致。
 *
 * @param {object} user user.json 行
 * @param {string[]|null} version DF 版本名列表（仅水鱼；null 时取全部成绩）
 * @returns {Promise<Array|{dfHint:string}>} PlayedResult[]（openid 无 QQ 时返回引导对象）
 */
export async function getPlayerResult(user, version = null) {
  if (effectiveService(user) !== 'lxns') {
    if (!hasNumericQq(user)) return { dfHint: DF_QQ_HINT }
    const api = new DivingFishAPI(user.qqid)
    const data = version !== null
      ? await api.queryUserPlate(version)
      : await api.queryUserRecords()
    return dfToPlayresult(data)
  }
  const api = new LxnsAPI(user.key ?? String(user.qqid ?? ''), getToken(user))
  return lxnsToPlayresult(await api.allBest(), null, mai.totalLevelValueMap)
}

/**
 * 绘制定数表（源 handler.py:322 draw_rating_table_text）
 * 纯本地渲染：不查分、不鉴权、不联网 —— 未绑定用户同样可用。
 * @param {string} rating 定数字面（"13" / "13+"）
 * @returns {Promise<Buffer|string>} 图 Buffer 或中文错误文案
 */
export async function drawRatingTableText(rating) {
  const levelData = mai.totalLevelData[rating]
  if (!levelData) return '无法识别的定数。'
  const view = ratingTableView({ rating, levelData, levelText: true, botName: botName() })
  return await renderPanel(`table-${rating}`, view)
}

/**
 * 绘制定数完成表（源 handler.py:496 draw_rating_table）
 * 需全量成绩（源 get_player_result(user)，不带 version）
 * @param {object} user
 * @param {string} rating 定数字面
 * @param {boolean} [plan] fc/ap 计划模式
 */
export async function drawRatingTable(user, rating, plan = false) {
  return handleErrors(async () => {
    const playResult = await getPlayerResult(user)
    if (playResult?.dfHint) return playResult.dfHint
    const levelData = mai.totalLevelData[rating]
    if (!levelData) return '无法识别的定数。'
    const { statistics, playedMap } = processRatingTableData(rating, playResult)
    const view = ratingTableView({ rating, levelData, plan, statistics, playedMap, botName: botName() })
    return await renderPanel(`plate-${rating}${plan ? '-fc' : ''}`, view)
  })
}

/**
 * 绘制版本称号完成表（源 handler.py:518 draw_plate_table）
 * DF 侧按版本列表走 /query/plate（只取该版本成绩，比全量轻）
 * @param {object} user
 * @param {string} version 短版本字（"真"/"双"/"舞"/"霸"…，已过 PLATE_CN 归一）
 * @param {string} plan 称号字
 * @param {number} page 1 基页码（仅舞/霸分两页）
 */
export async function drawPlateTable(user, version, plan, page = 1) {
  return handleErrors(async () => {
    const entry = VERSION_MAP[version]
    if (!entry) return '无法识别的定数。'
    const [versionList, versionName] = entry
    const playResult = await getPlayerResult(user, versionList)
    if (playResult?.dfHint) return playResult.dfHint

    const isWu = version === '舞' || version === '霸'
    const remasterIdSet = isWu ? new Set(mai.totalPlateIdList['舞ReMASTER'] ?? []) : null
    const data = processPlateTable({
      version, versionName, isWu, page, plan, playResult,
      plateIdList: mai.totalPlateIdList, totalList: mai.totalList,
    })
    const view = plateTableView({ version, isWu, page, plan, data, remasterIdSet, botName: botName() })
    return await renderPanel(`plate-${version}-${plan}-${page}`, view)
  })
}

/**
 * 绘制牌子完成进度（源 handler.py:549 draw_plate_progress）
 * 与完成表同数据层，但版式为「每难度未完成清单」；page 仅透传（源进度页不使用分页）
 */
export async function drawPlateProgress(user, version, plan, page = 1) {
  return handleErrors(async () => {
    const entry = VERSION_MAP[version]
    if (!entry) return '无法识别的定数。'
    const [versionList, versionName] = entry
    const playResult = await getPlayerResult(user, versionList)
    if (playResult?.dfHint) return playResult.dfHint

    const isWu = version === '舞' || version === '霸'
    const data = processPlateTable({
      version, versionName, isWu, page, plan, playResult,
      plateIdList: mai.totalPlateIdList, totalList: mai.totalList,
    })
    const view = plateProgressView({ version, isWu, plan, data, botName: botName() })
    return await renderPanel(`plateprogress-${version}-${plan}`, view)
  })
}

// PLAN_MAP 定义已下沉到 lib/tableData.js（纯函数，便于离线 fixture 复用）；此处转出保持导出面
/** 源 RISE_ACHIEVEMENT_LIST = ACHIEVEMENT_LIST[-4:] */
export const RISE_ACHIEVEMENT_LIST = ACHIEVEMENT_LIST.slice(-4)

/**
 * 等级进度（源 handler.py:621 draw_level_progress）
 * @param {object} user
 * @param {string} level 定数字面
 * @param {string} plan 评价目标（PLAN_MAP 键）
 * @param {'default'|'completed'|'unfinished'|'notplayed'} category
 * @param {number} page
 */
export async function drawLevelProgress(user, level, plan, category = 'default', page = 1) {
  return handleErrors(async () => {
    const playResult = await getPlayerResult(user)
    if (playResult?.dfHint) return playResult.dfHint

    const { completed, unfinished, notplayed } = processLevelProgress({
      level, plan, playResult, byPlan: mai.totalList.byPlan(level),
    })

    const heights = levelPlanHeights({ category, completed, unfinished, notplayed, page })
    const serviceName = serviceDisplay(effectiveService(user))
    const common = { serviceName, botName: botName() }
    const view = heights.mode === 'plan'
      ? levelPlanView({
        level, plan, completed, unfinished, notplayed, heights,
        cmdHead: Config.getUserCfg('config', 'cmdhead') || 'mai', ...common,
      })
      : levelCategoryView({
        category,
        data: heights.mode === 'notplayed'
          ? notplayed
          : (category === 'completed' ? completed : unfinished),
        heights,
        ...common,
      })
    return await renderPanel(`progress-${level}-${plan}-${category}-${page}`, view)
  })
}

/**
 * 分数列表（源 handler.py:734 draw_level_score_list）
 * 定数据可为**定数字面**（按 level 匹配）或**数值**（按 level_value 匹配），源同款二选一
 */
export async function drawLevelScoreList(user, rating, page = 1) {
  return handleErrors(async () => {
    const playResult = await getPlayerResult(user)
    if (playResult?.dfHint) return playResult.dfHint

    const list = processLevelScoreList({ rating, playResult })

    const lay = levelScoreListLayout(list.length, page)
    const view = levelScoreListView({
      rating, playResult: list, page: lay.page, endPage: lay.endPage,
      serviceName: serviceDisplay(effectiveService(user)), botName: botName(),
    })
    return await renderPanel(`scorelist-${rating}-${lay.page}`, view)
  })
}

/**
 * 绘制上分推荐（源 handler.py:581 draw_rise_score_list）
 * 旧/新版本两列（sd 走旧版本池、dx 走新版本池），两列皆空 → NotMusicRecommendationError
 * @param {object} user
 * @param {string|null} level 目标等级
 * @param {number|null} score 目标涨幅
 */
export async function drawRiseScoreList(user, level = null, score = null) {
  return handleErrors(async () => {
    const [player, best50] = await getBest50(user)
    void player
    if (best50?.dfHint) return best50.dfHint
    const playResult = await getPlayerResult(user)
    if (playResult?.dfHint) return playResult.dfHint

    const oldRecords = new Map(playResult.map(v => [`${v.song_id}-${v.level_index}`, v]))
    const deps = { totalList: mai.totalList }
    const sd = getRiseScoreList(oldRecords, 'sd', best50.sd, level, score, deps)
    const dx = getRiseScoreList(oldRecords, 'dx', best50.dx, level, score, deps)
    if (!sd.list.length && !dx.list.length) throw new NotMusicRecommendationError()

    const view = riseView({
      sd: sd.list, sdLow: sd.lowestRa, dx: dx.list, dxLow: dx.lowestRa,
      serviceName: serviceDisplay(effectiveService(user)), botName: botName(),
    })
    return await renderPanel('rise', view)
  })
}

/** 分数线命令的帮助文本（源走 text_to_bytes_io 转图，设计 §6.4 改发文本；命令示例已改成本插件语法） */
export const FSLINE_HELP = [
  '此功能为查找某首歌分数线设计，输出一张分数线成图，',
  '内含「分数线」「DX 等级」「目标评级」「BREAK 等效数量」四张表。',
  '命令格式：#mai fsline [难度色]<曲名|id|别名> [目标达成率]',
  '难度色（绿/黄/红/紫/白）可放在曲名前，也可作为独立词放在曲名后。',
  '例如：#mai fsline 紫799        （只出图）',
  '      #mai fsline 紫799 100    （出图，并附一行该达成率下的容错文本）',
  '      #mai fsline 799 紫 100   （难度色与曲名顺序可互换）',
  '注：四张表均由物量（TAP/HOLD/SLIDE/TOUCH/BREAK 个数）推出，与达成率无关。',
  '以下为「TAP」「GREAT」的对应表：',
  '        GREAT / GOOD / MISS',
  'TAP         1 / 2.5  / 5',
  'HOLD        2 / 5    / 10',
  'SLIDE       3 / 7.5  / 15',
  'TOUCH       1 / 2.5  / 5',
  'BREAK       5 / 12.5 / 25 (外加200落)',
].join('\n')

/**
 * 分数线参数错误文案（按缺失项精确提示，替代笼统的 FSLINE_FORMAT_ERROR）
 * 示例里的 `#mai` 命令头与 FSLINE_HELP 同一约定：写死默认头（cmdhead 可改，但错误文案
 * 跟帮助页一样按默认头举例，避免每次渲染都拼配置）。
 */
export const FSLINE_ARGS_ERRORS = {
  usage: '缺少参数。命令格式：#mai fsline [难度色]<曲名|id|别名> [目标达成率]\n'
    + '难度色（绿/黄/红/紫/白）可放在曲名前或作为独立词放在曲名后，达成率可省略\n'
    + '例如：#mai fsline 紫799 或 #mai fsline 799 紫 100',
  missingQuery: '缺少曲名：难度色后需要 <曲名|id|别名>\n例如：#mai fsline 紫799 或 #mai fsline 799 紫',
  missingColor: '缺少难度色（绿/黄/红/紫/白）：可放在曲名前或作为独立词放在曲名后\n例如：#mai fsline 紫799 或 #mai fsline 799 紫',
}

/** 分数线格式错误文案（源 mai_score.py:171，含 CJK 引号） */
export const FSLINE_FORMAT_ERROR = '格式错误，输入“分数线 帮助”以查看帮助信息'

/**
 * 分数线换算（源 commands/mai_score.py:139-167 的计算与文案）
 *
 * 纯函数，便于单测。**不做除零保护**：源在 brk==0 时抛 ZeroDivisionError 且不在
 * `except (AttributeError, ValueError)` 内 —— 调用方需自行兜底（见 drawFsline 的 handleErrors）。
 *
 * @param {object} song Song
 * @param {number} levelIndex 0..4
 * @param {number} line 目标达成率
 * @returns {string} 结果文本
 */
export function fslineText(song, levelIndex, line) {
  const chart = song.difficulties[levelIndex]
  if (!chart) return FSLINE_FORMAT_ERROR
  const notes = chart.notes ?? {}
  const tap = Math.trunc(notes.tap ?? 0)
  const slide = Math.trunc(notes.slide ?? 0)
  const hold = Math.trunc(notes.hold ?? 0)
  const touch = Math.trunc(notes.touch ?? 0)
  const brk = Math.trunc(notes.brk ?? 0)

  const reduce = 101 - line
  if (reduce <= 0 || reduce >= 101) return FSLINE_FORMAT_ERROR

  const totalScore = tap * 500 + slide * 1500 + hold * 1000 + touch * 500 + brk * 2500
  // ⚠️ 刻意的偏离：源此处 `0.01/brk` 在 brk==0 时抛 ZeroDivisionError，而它**不在**
  // `except (AttributeError, ValueError)` 名单内 → 异常逃逸到 NoneBot 日志、用户得不到任何回复。
  // JS 里 1/0 只是 Infinity（不抛），会渲染出 "Infinity%" 这种脏文案；故显式退化为格式错误文案。
  // （brk > 0 即保证 totalScore >= 2500 > 0，故无需再判 totalScore。）
  if (brk === 0) return FSLINE_FORMAT_ERROR

  const breakBonus = 0.01 / brk
  const break50Reduce = totalScore * breakBonus / 4

  return `${song.song_name}「${DIFFS[levelIndex]}」\n`
    // 源 line 来自 float()，故整值要打 .0（100 → "100.0%"，与 py str(float) 一致）
    + `分数线「${pyFloat(line)}%」\n允许的最多「TAP」「GREAT」数量为\n`
    + `「${(totalScore * reduce / 10000).toFixed(2)}」(每个-${(10000 / totalScore).toFixed(4)}%),\n`
    + `「BREAK」50落(一共「${brk}」个)\n`
    + `等价于「${(break50Reduce / 100).toFixed(3)}」个「TAP」`
    + `「GREAT」(-${(break50Reduce / totalScore * 100).toFixed(4)}%)`
}

/**
 * 分数线海报视图（prism_plus 版式，算法见 lib/fsline.js）
 *
 * 版式与数据口径照搬用户样板；**四项表只由物量推出**，与达成率无关。
 * @param {object} song Song
 * @param {number} levelIndex 0..4
 */
export function fslineView(song, levelIndex) {
  const chart = song.difficulties?.[levelIndex]
  const notes = chart?.notes ?? {}
  const data = computeFsline({
    tap: notes.tap, hold: notes.hold, slide: notes.slide, touch: notes.touch, break: notes.brk,
  })
  return {
    coverSrc: songChartSrc(song.song_id),
    song: {
      title: song.song_name,
      artist: song.artist,
      id: song.song_id,
      genre: song.genre,
      // 长分区名（niconico & VOCALOID）在样板里有更紧凑的行高变体
      genreClass: CATEGORY[song.genre] === 'niconico' ? ' niconicoVOCALOID' : '',
      bpm: song.bpm,
      isDx: song.type === 'DX',
    },
    diff: {
      // 与 chart_info / play_info 卡片同一写法：DIFFS 原样（Master / Re:Master），不再全大写
      name: String(DIFFS[levelIndex] ?? ''),
      value: `${chart?.level ?? ''}(${pyFloat(chart?.level_value ?? 0)})`,
      cls: `dif-${DIFF_BG_NAMES[levelIndex] ?? 'basic'}`,
    },
    counts: data.counts,
    scoreRows: data.scoreRows,
    brk: data.brk,
    // 99%/98% 是文字行、5..1 是星徽章图（样板同款分支）——只有星行才去取图标
    dx: data.dx.map(row => {
      const isPercent = String(row.label).endsWith('%')
      return { ...row, isPercent, iconSrc: isPercent ? '' : dxStarIcon(row.label) }
    }),
    rating: data.rating,
    equiv: data.equiv,
  }
}

/**
 * 绘制分数线海报（版式/算法复用用户样板；四表由物量推出）
 * @returns {Promise<Buffer|string>} 图 Buffer 或失败文案
 */
export async function drawFsline(song, levelIndex) {
  return handleErrors(async () => await renderFsline(fslineView(song, levelIndex)))
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

/**
 * 投票列表排序（**`#N` 编号口径的唯一来源**）
 *
 * 服务端返回顺序未必稳定，而 `#N` 必须在「看图」与「投票」两次独立请求之间指向同一行
 * （两次都会重新 `getStatus()`），故两侧都套用这一个确定性排序：先 song_id 升序、再 tag 升序。
 * 改这里等于改编号口径，务必同步 `apps/song.js:voteAlias` 的解析。
 */
export function sortVotes(votes) {
  return [...(votes ?? [])].sort(
    (a, b) => (a.song_id - b.song_id) || String(a.tag).localeCompare(String(b.tag)),
  )
}

/**
 * 绘制别名投票列表（复用曲目列表版式；源 `mai_alias.py:125-155` 的 text_to_bytes_io 已废除，
 * 但投票行带曲绘信息，出图比转发文本可读得多 ⇒ 保留出图形态）
 * @param {Array} votes 已由 `sortVotes` 排好序的投票数组（编号即此序）
 */
export async function drawVoteList(votes, page = 1) {
  return handleErrors(async () => {
    const { page: p, totalPage, slice } = songListPaging(votes.length, page)
    const view = voteListView({
      votes: votes.slice(slice[0], slice[1]),
      page: p,
      totalPage,
      startIndex: slice[0], // 跨页连续编号：第 2 页从 15 起
      botName: botName(),
    })
    return await renderVoteList(view)
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
