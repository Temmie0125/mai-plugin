/**
 * 错误文案表（源 core/handler_error.py + commands/depend.py AUTHORIZE_ERROR 直译）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。用户可见信息保持中文文案逐条一致。
 */
import {
  DivingFishNotAuthorizedError,
  DivingFishOAuthError,
  DivingFishTokenDisableError,
  DivingFishTokenError,
  DivingFishTokenNotFoundError,
  DivingFishTooManyRequestsError,
  DivingFishUserDisabledQueryError,
  DivingFishUserNotFoundError,
  MusicNotPlayError,
  NotMusicRecommendationError,
  UserNotExistsError,
  LXNSAuthRequiredError,
  LXNSNotFoundError,
  LXNSOAuthError,
  LXNSParamsError,
  LXNSPermissionDeniedError,
  LXNSTokenError,
  LXNSTooManyRequestsError,
} from './client/errors.js'
import Config, { head } from './config.js'

const logger = global.logger || console

/**
 * BOT 展示名：与 lib/render/picmodle.js 的 botName 同一条链（配置 → 宿主昵称），
 * 末位刻意不同——那边兜 'Maimai'，这边兜 '本'，即未配置时仍是原来的「本 BOT」文案。
 * 直读配置而非 import picmodle，免得把渲染层（puppeteer）拖进每条错误路径。
 */
const botName = () => Config.getUserCfg('config', 'botName') || globalThis.Bot?.name || '本'

/** 命令头按配置动态拼接，函数形态供错误发生期调用 */
export const NOTAUTHORIZED = () =>
  `您尚未授权「${botName()} BOT」访问您的水鱼查分器成绩，或已取消授权。\n`
  + `请发送「#${head()} bind df」，按提示完成授权后再试。`

export const NOTFOUNDUSER = [
  '未在水鱼查分器找到此玩家，请确保此玩家的用户名和查分器中的用户名相同。',
  '如未绑定，请前往查分器官网进行绑定。',
  'https://www.diving-fish.com/maimaidx/prober/',
].join('\n')

/**
 * 水鱼按 QQ 号代查未找到玩家（"user not exists"，b50 等自查命令的主路径）。
 * 服务端只回一句 user not exists，两种成因区分不了，故并列给出引导：
 * ① 未注册/导入水鱼；② 已注册但查分器内没绑定该 QQ 号。
 */
export const USER_NOT_EXISTS = () =>
  [
    '未在水鱼查分器找到该 QQ 号对应的玩家，常见原因：',
    '1. 尚未注册水鱼查分器或未导入成绩：',
    '   请前往 https://www.diving-fish.com/maimaidx/prober/ 注册并导入',
    '2. 已注册，但未在查分器内绑定该 QQ 号：',
    '   请在水鱼查分器官网的设置中绑定 QQ 号后重试',
    `也可以发送「#${head()} bind df」改用授权方式查询，不依赖查分器内的 QQ 号绑定。`,
  ].join('\n')

/**
 * 落雪 403：既可能是玩家侧隐私设置未放行（三选项缺一不可），也可能是 BOT 侧令牌权限。
 * 按用户反馈，隐私设置是高频成因，故排在管理员排查之前。
 */
export const LXNS_PERMISSION_DENIED = [
  '落雪查分器拒绝了本次读取，请依次检查：',
  '1. 您这边：在落雪查分器「账号设置 → 隐私设置」中开启以下三个选项',
  '   （缺一不可，未开启时 BOT 将无法获取您的落雪数据）：',
  '   ・允许读取玩家信息',
  '   ・允许读取谱面成绩',
  '   ・允许读取历史成绩',
  '2. BOT 这边：开发者令牌权限不足，请联系 BOT 管理员检查相关信息。',
].join('\n')

/** 落雪未授权（源 depend.py AUTHORIZE_ERROR，botName 运行时拼接） */
/**
 * 落雪「这个成绩集是空的」（`404 score not found`）
 *
 * 实测：**没有 AP 成绩的玩家**查 AP50 就会拿到这个 404 —— 是正常状态而非故障。
 * （AP50 路径由 handler.getAp50 先接住并回更具体的空结果文案，见 AP50_EMPTY_TEXT；
 *   本文案是其余调用点的兜底，如某玩家整个 B50 为空。）
 */
export const LXNS_NO_SCORE = () =>
  '落雪没有符合条件的成绩（该成绩集为空，或尚未上传成绩）。'

/** 落雪「好友码无效」（`400 invalid friend code`）——存的好友码不对，引导重绑 */
export const LXNS_INVALID_FRIEND_CODE = () => {
  const h = head()
  return '落雪好友码无效或已失效，无法查询。\n'
    + `※ 请重新发送「#${h} bind fc <好友码>」绑定当前好友码（或「#${h} bind lxns」完成授权）。`
}

/**
 * 「该功能需要落雪授权」引导（好友码绑定只能查 B50 / AP50 / 单曲，见 lib/client/lxns.js:allBest）
 *
 * 措辞要点：说清**为什么**（不是操作失误）与**怎么办**（补 OAuth 授权），
 * 否则用户会以为是自己没绑好友码。
 */
export const LXNS_AUTH_REQUIRED = () =>
  '该功能需要读取你的**全量成绩**，而落雪开发者接口只提供简化成绩（不含达成率）。\n'
  + `※ 请发送「#${head()} bind lxns」完成一次授权（绑定好友码只能查 B50 / AP50 / 单曲成绩）。`

export function authorizeError(botName) {
  return `您尚未授权「${botName} BOT」访问您的落雪查分器数据，请先发送「#${head()} bind lxns」进行绑定。`
}

/**
 * 错误 → 用户可见文案；未知错误返回 null（调用方兜底）
 * @returns {string|null}
 */
export function errorMessage(error) {
  // 水鱼
  if (error instanceof DivingFishNotAuthorizedError) return NOTAUTHORIZED()
  if (error instanceof DivingFishTooManyRequestsError) return '水鱼查分器请求次数已达上限，请稍后再试。'
  if (error instanceof DivingFishOAuthError) {
    logger.error('水鱼账号服务请求失败。')
    return '水鱼账号服务暂时不可用，请稍后再试。'
  }
  if (error instanceof DivingFishUserNotFoundError) return NOTFOUNDUSER
  if (error instanceof UserNotExistsError) return USER_NOT_EXISTS()
  if (error instanceof DivingFishUserDisabledQueryError) return '该用户禁止了其他人获取数据或未同意用户协议。'
  if (error instanceof DivingFishTokenDisableError
    || error instanceof DivingFishTokenNotFoundError
    || error instanceof DivingFishTokenError) {
    logger.error('水鱼开发者Token异常，请自行检查。')
    return '请联系BOT管理员检查水鱼查分器相关信息，暂时无法查询。'
  }

  // 落雪
  if (error instanceof LXNSTokenError) return '落雪查分器授权错误，请尝试重新绑定授权。'
  if (error instanceof LXNSAuthRequiredError) return LXNS_AUTH_REQUIRED()
  if (error instanceof LXNSPermissionDeniedError) return LXNS_PERMISSION_DENIED
  /**
   * ⚠️ 落雪用同一端点家族表达两类语义完全不同的结果（实测 2026-09-15，见 lib/client/lxns.js 注释）：
   *   400 `invalid friend code` → 好友码是错的 ⇒ 引导重新绑定
   *   404 `score not found`     → 好友码没问题，只是**没有这类成绩** ⇒ 不是故障，别让用户去找管理员
   * 故先按响应体 message 细分，认不出来才回落到笼统文案。
   */
  if (error instanceof LXNSParamsError && error.apiMessage === 'invalid friend code') return LXNS_INVALID_FRIEND_CODE()
  if (error instanceof LXNSNotFoundError && error.apiMessage === 'score not found') return LXNS_NO_SCORE()
  if (error instanceof LXNSNotFoundError) return '未找到落雪查分器相关资源，请联系BOT管理员检查相关信息。'
  if (error instanceof LXNSTooManyRequestsError) return '使用落雪查分器的请求次数过多，请稍后再试。'
  if (error instanceof LXNSParamsError) {
    logger.error(`请求参数错误。\n${error.stack}`)
    return '使用落雪查分器请求时发生错误，请联系BOT管理员检查相关信息。'
  }
  if (error instanceof LXNSOAuthError) return '落雪查分器授权错误，请重试，依旧错误请重新绑定授权。'

  // 其它
  if (error instanceof MusicNotPlayError) return '您未游玩过曲目。'
  if (error instanceof NotMusicRecommendationError) return '没有乐曲推荐呢。可能是您太强了。'
  return null
}

/**
 * 源 @handle_errors 装饰器：包装 draw_* 类函数，异常转可发送文案。
 * 正常返回原值（Buffer / 数组等回复载荷）。
 */
export async function handleErrors(fn) {
  try {
    return await fn()
  } catch (error) {
    const msg = errorMessage(error)
    if (msg != null) return msg
    logger.error(`发生错误: ${error?.stack || error}`)
    return `发生未知错误：${error?.name || 'Error'}\n请联系BOT管理员。`
  }
}
