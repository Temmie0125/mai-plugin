/**
 * #mai table / plate 表格族（源 commands/mai_table.py，设计 §3.2-25～31）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 *
 * 命令形态与源触发词的对应：
 *   源 `([0-9]+\+?)定数表`        → `table <定数>` / `定数表 <定数>`
 *   源 `RATING_PATTERN 完成表`     → `plate <定数> [fc|ap]`
 *   源 `TABLE_PATTERN 完成表/进度` → `plate <版本称号> [完成表|进度] [页]`
 *   源 `牌子条件`                 → `plateinfo`
 *   源 `LEVEL_PATTERN 进度`       → `progress <定数> <目标> [类别] [页]`
 *   源 `LEVEL_LIST_PATTERN 分数列表` → `list <定数> [页]`
 *
 * ⚠️ 规则按声明序首中先服务（宿主 loader.js:288）：**数字在前的定数完成表规则必须排在
 * 版本称号规则之前**，靠数字/版本字面的互斥天然消歧，不用负向前瞻。
 */
import fs from 'node:fs'
import path from 'node:path'
import plugin from '../../../lib/plugins/plugin.js'
import { staticRoot } from '../lib/path.js'
import { head } from '../lib/config.js'
import { ensureReady } from '../lib/service.js'
import {
  drawLevelProgress, drawLevelScoreList, drawPlateProgress, drawPlateTable,
  drawRatingTable, drawRatingTableText,
} from '../lib/handler.js'
import { toSegment, botName } from '../lib/render/picmodle.js'
import { getUserAndAuth } from '../lib/user.js'
import { COMBO_PLUS, LEVEL_LIST, PLATE_CN, RANK_PLUS, SYNC_PLUS } from '../lib/constants.js'

const H = () => head()

/** 版本字（源 TABLE_PATTERN 首字集合，含 PLATE_CN 简繁对） */
export const VERSION_CHARS = '真超檄橙暁晓桃櫻樱紫菫堇白雪輝辉舞霸熊華华爽煌星宙祭祝双宴镜彩'
/** 称号字（源 `[極极将舞神者]`，舞 单列以区分「舞舞」） */
export const PLAN_CHARS = '極极将神者'

const REG_TABLE = () => new RegExp(`^[#/]${H()}\\s*(?:table|定数表)\\s+(\\d+\\+?)\\s*$`)
const REG_RATING_PLATE = () => new RegExp(`^[#/]${H()}\\s*plate\\s+(\\d+\\+?)(?:\\s+(\\S+))?\\s*$`)
/** 牌子条件说明 */
const REG_PLATE_INFO = () => new RegExp(`^[#/]${H()}\\s*(?:plateinfo|牌子条件)\\s*$`)

/**
 * 等级进度。等级/目标均设为可选，好让缺参时回落源文案「输入错误，请重新输入难度等级。」，
 * 与源「先匹配后校验」的行为一致。
 *
 * ⚠️ 目标集合必须照抄源 `(?:a+|b+|c|d|s+|ap|fc|fs|fdx)\+?` —— 其中 `a+`/`b+`/`s+` 是
 * **量词**（一个或多个 a/b/s），不是字面量 `a\+`；写成后者会让 'bb'/'sss' 这类目标全部失配。
 * 类别限汉字，避免把尾部页码吃进类别组。
 * ⚠️ 源 LEVEL_PATTERN 带 re.IGNORECASE，但宿主 loader 以 `new RegExp(reg)` 编译 rule
 * （flags 无法经 .source 传递），故大小写折叠必须显式写进字符类（[aA]+ 等），勿用 'i' 标志。
 */
const REG_PROGRESS = () => new RegExp(
  `^[#/]${H()}\\s*(?:progress|进度查询)`
  + `(?:\\s+([0-9]+\\+?))?(?:\\s+((?:[aA]+|[bB]+|[cC]|[dD]|[sS]+|[aA][pP]|[fF][cC]|[fF][sS]|[fF][dD][xX])\\+?))?`
  + `(?:\\s+([\\u4e00-\\u9fa5]+))?(?:\\s+(\\d+))?\\s*$`
)

/** 分数列表：定数为「等级字面」或「一位小数定数」 */
const REG_LIST = () => new RegExp(
  `^[#/]${H()}\\s*(?:list|分数列表)(?:\\s+([0-9]+(?:\\.[0-9]+)?\\+?))?(?:\\s+(\\d+))?\\s*$`
)

/** 源 CATEGORY_ALIAS（mai_table.py:34）：中文类别词 → 内部类别 */
export const CATEGORY_ALIAS = {
  已完成: 'completed', 未完成: 'unfinished', 未开始: 'notplayed', 未游玩: 'notplayed',
}

/**
 * 版本称号完成表 / 进度。
 *
 * 相较源 TABLE_PATTERN 的 `([極极将舞神者]舞?)`，此处收紧为 `(舞舞|[極极将神者])(?:舞)?` ——
 * 源会把「真极舞进度」解析成 plan='极舞'（必然缺图报错），而设计文档承诺它表示「进度」；
 * 收紧后前者得到正确语义，代价是「真舞完成表」静默不匹配（源是抛错，但本就不存在 真舞.png）。
 *
 * 与源的另两处差异：
 *  1. 源「完成」二字必需，本插件 `plate <版本称号> [页]`（设计 §3.2-28）允许整段省略；
 *  2. 源由「命中哪个 matcher」区分完成表/进度，此处由参数词区分（k3）。
 */
const REG_VERSION_PLATE = () => new RegExp(
  `^[#/]${H()}\\s*plate\\s+([${VERSION_CHARS}])(舞舞|[${PLAN_CHARS}])(?:舞)?`
  + `(?:\\s*(完成表?|进度))?\\s*(\\d+)?\\s*$`
)

/** 口语形态「完成表/进度」为必需（源 TABLE_PATTERN 二者必居其一），故不加可选 */
const REG_VERSION_PLATE_SAY = () => new RegExp(
  `^([${VERSION_CHARS}])(舞舞|[${PLAN_CHARS}])(?:舞)?\\s*(完成表?|进度)(\\d+)?$`
)

/**
 * 版本称号完成表参数归一（`#mai plate` 子命令与口语「真极完成表」共用，防两条路径漂移）
 * 源 mai_table.py:122 顺序：PLATE_CN 简繁归一 → 真将守卫
 * @returns {{ver:string, plan:string, page:number, isProgress:boolean}|{error:string}}
 */
export function parseVersionPlate(ver, plan, kindRaw, pageRaw) {
  let v = ver
  if (PLATE_CN[v]) v = PLATE_CN[v]
  if (`${v}${plan}` === '真将') return { error: '真系没有真将哦。' }
  const page = parseInt(pageRaw || '1', 10)
  // 源由「命中哪个 matcher」区分完成表/进度；收编为子命令后由参数词区分，缺省为完成表
  const isProgress = (kindRaw || '').startsWith('进度')
  return { ver: v, plan, page: Number.isFinite(page) && page > 0 ? page : 1, isProgress }
}

/**
 * 表格族命令类
 * ⚠️ rule 声明序即匹配序（宿主首中先服务）：**数字在前的定数完成表必须排在版本称号完成表之前**，
 * 靠「数字」与「版本字」互斥天然消歧；plateinfo 无空格，与 `plate\s+…` 本就不冲突。
 */
export class MaiTable extends plugin {
  constructor() {
    super({
      name: 'mai-table',
      dsc: '舞萌DX定数表',
      event: 'message',
      priority: 100,
      rule: [
        { reg: REG_PLATE_INFO().source, fnc: 'plateInfo' },
        { reg: REG_TABLE().source, fnc: 'ratingTable' },
        { reg: REG_RATING_PLATE().source, fnc: 'ratingPlate' },
        { reg: REG_VERSION_PLATE().source, fnc: 'versionPlate' },
        { reg: REG_PROGRESS().source, fnc: 'levelProgress' },
        { reg: REG_LIST().source, fnc: 'levelScoreList' },
      ],
    })
  }

  /** #mai table <定数> —— 源 mai_table.py:71 rating_table.handle */
  async ratingTable(e) {
    if (!(await ensureReady(e))) return true
    const rating = (e.msg.match(REG_TABLE()) || [])[1]
    if (!rating) {
      await this.reply('请输入定数，例如「#mai table 13」。', true)
      return true
    }
    // 源LEVEL_LIST[:6] —— lv1-6 无定数表
    if (LEVEL_LIST.slice(0, 6).includes(rating)) {
      await this.reply('只支持查询lv7-15的定数表。', true)
      return true
    }
    if (!LEVEL_LIST.slice(6).includes(rating)) {
      await this.reply('无法识别的定数。', true)
      return true
    }
    const result = await drawRatingTableText(rating)
    await this.reply(toSegment(result), true)
    return true
  }

  /**
   * #mai plate <定数> [fc|ap] —— 源 mai_table.py:83 rating_table_pfm.handle
   * 判定顺序照搬源：① lv1-6 ② 在 lv7-15 内先校验计划名 ③ 其余为未知定数
   * （注意源正则虽收 s/fs/fdx，但守卫只放 COMBO_PLUS —— 这个不对称是源行为，勿"修正"）
   */
  async ratingPlate(e) {
    if (!(await ensureReady(e))) return true
    const m = e.msg.match(REG_RATING_PLATE()) || []
    const rating = m[1]
    const plan = (m[2] || '').toLowerCase()

    if (LEVEL_LIST.slice(0, 6).includes(rating)) {
      await this.reply('只支持查询lv7-15的完成表。', true)
      return true
    }
    if (!LEVEL_LIST.slice(6).includes(rating)) {
      await this.reply('无法识别的定数。', true)
      return true
    }
    if (plan && !COMBO_PLUS.includes(plan)) {
      await this.reply('完成表目前仅支持「fc」「ap」计划，例如「13fc完成表」「13ap完成表」。', true)
      return true
    }

    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    const payload = await drawRatingTable(got.user, rating, Boolean(plan))
    await this.reply(toSegment(payload), true)
    return true
  }

  /**
   * #mai plate <版本称号> [完成表] [页] —— 源 mai_table.py:112 共享处理器（完成表支）
   * 「真极完成表」「舞舞舞完成表」等源触发词按设计 §3.2-28 收编为子命令
   */
  async versionPlate(e) {
    if (!(await ensureReady(e))) return true
    const m = e.msg.match(REG_VERSION_PLATE()) || []
    await this.runVersionPlate(e, parseVersionPlate(m[1], m[2], m[3], m[4]))
    return true
  }

  /**
   * #mai progress <定数> <目标> [类别] [页] —— 源 mai_table.py:133 level_progress
   * 校验顺序与文案逐条照搬源（含「兄啊，有点志向好不好。」的等级/档位双门槛）
   */
  async levelProgress(e) {
    if (!(await ensureReady(e))) return true
    const m = e.msg.match(REG_PROGRESS()) || []
    const level = m[1]
    const plan = (m[2] || '').toLowerCase()
    const categoryRaw = m[3]
    const page = parseInt(m[4] || '1', 10)

    if (!level || !plan) {
      await this.reply('输入错误，请重新输入难度等级。', true)
      return true
    }
    if (!LEVEL_LIST.includes(level)) {
      await this.reply('无此等级。', true)
      return true
    }
    if (![...RANK_PLUS, ...COMBO_PLUS, ...SYNC_PLUS].includes(plan)) {
      await this.reply('无此评价等级。', true)
      return true
    }
    // 双门槛：等级需 ≥ 9+（index 11）；rank 类目标需 ≥ s（index 8）
    if (LEVEL_LIST.indexOf(level) < 11
      || (RANK_PLUS.includes(plan) && RANK_PLUS.indexOf(plan) < 8)) {
      await this.reply('兄啊，有点志向好不好。', true)
      return true
    }
    let category = 'default'
    if (categoryRaw) {
      const mapped = CATEGORY_ALIAS[categoryRaw]
      if (!mapped) {
        await this.reply(`无法指定查询「${categoryRaw}」。`, true)
        return true
      }
      category = mapped
    }

    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    const payload = await drawLevelProgress(got.user, level, plan, category, page)
    await this.reply(toSegment(payload), true)
    return true
  }

  /** #mai list <定数> [页] —— 源 mai_table.py:167 level_score_list（小数定数走 level_value 匹配） */
  async levelScoreList(e) {
    if (!(await ensureReady(e))) return true
    const m = e.msg.match(REG_LIST()) || []
    const raw = m[1]
    const page = parseInt(m[2] || '1', 10)
    if (!raw) {
      await this.reply('输入错误，请重新输入指定等级。', true)
      return true
    }
    let rating = raw
    if (raw.includes('.')) {
      // 定数仅一位小数，多位视为输入有误（源 re.fullmatch(r"[0-9]+\.[0-9]", rating)）
      if (!/^[0-9]+\.[0-9]$/.test(raw)) {
        await this.reply('输入有误，定数仅有一位小数。', true)
        return true
      }
      rating = Math.round(parseFloat(raw) * 10) / 10   // 源 round(float(rating), 1)
    } else if (!LEVEL_LIST.includes(raw)) {
      await this.reply('无此等级。', true)
      return true
    }

    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    const payload = await drawLevelScoreList(got.user, rating, page)
    await this.reply(toSegment(payload), true)
    return true
  }

  /** 牌子条件说明图（源 mai_table.py:103 plate_table_condition：原样发送静态图，不做缩放） */
  async plateInfo(e) {
    const file = path.join(staticRoot, 'mai', 'pic', 'table_condition.jpg')
    if (!fs.existsSync(file)) {
      await this.reply('未找到牌子条件图（resources/static/mai/pic/table_condition.jpg），请检查资源包完整性。', true)
      return true
    }
    await this.reply(toSegment(fs.readFileSync(file)), true)
    return true
  }

  /**
   * 版本完成表共用执行体（子命令与口语两入口共用，避免行为漂移）
   * @param {object} e
   * @param {{ver:string,plan:string,page:number}|{error:string}} parsed
   * @returns {Promise<boolean>} 是否已消费该消息（口语入口据此决定是否放行）
   */
  async runVersionPlate(e, parsed) {
    if (parsed.error) {
      await this.reply(parsed.error, true)
      return true
    }
    const got = await getUserAndAuth(e, { requireAuth: true, botName: botName() })
    if (!got) return true
    const payload = parsed.isProgress
      ? await drawPlateProgress(got.user, parsed.ver, parsed.plan, parsed.page)
      : await drawPlateTable(got.user, parsed.ver, parsed.plan, parsed.page)
    await this.reply(toSegment(payload), true)
    return true
  }
}

/**
 * 口语「真极完成表」系列（源 mai_table.py:47 的免前缀形态，设计 §3.2-28 保留）
 * priority 1500、log:false，未命中自身语义一律 return false 放行
 */
export class MaiTableSay extends plugin {
  constructor() {
    super({
      name: 'mai-table-say',
      dsc: '舞萌DX口语完成表',
      event: 'message',
      priority: 1500,
      rule: [
        { reg: REG_VERSION_PLATE_SAY().source, fnc: 'versionPlateSay', log: false },
      ],
    })
  }

  /** 免前缀「真极完成表」；未命中语义一律 false 放行（源非阻塞语义） */
  async versionPlateSay(e) {
    const m = e.msg.match(REG_VERSION_PLATE_SAY())
    if (!m) return false
    if (!(await ensureReady(e))) return false
    // 与 `#mai plate` 共用同一执行体（prototype 调用），杜绝两入口行为漂移
    return await MaiTable.prototype.runVersionPlate.call(this, e, parseVersionPlate(m[1], m[2], m[3], m[4]))
  }
}
