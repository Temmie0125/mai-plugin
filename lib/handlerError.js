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
  LXNSNotFoundError,
  LXNSOAuthError,
  LXNSParamsError,
  LXNSPermissionDeniedError,
  LXNSTokenError,
  LXNSTooManyRequestsError,
} from './client/errors.js'

const logger = global.logger || console

export const NOTAUTHORIZED = [
  '您尚未授权本 BOT 访问您的水鱼查分器成绩，或已取消授权。',
  '请发送「#mai bind df」，按提示完成授权后再试。',
].join('\n')

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
export const USER_NOT_EXISTS = [
  '未在水鱼查分器找到该 QQ 号对应的玩家，常见原因：',
  '1. 尚未注册水鱼查分器或未导入成绩：',
  '   请前往 https://www.diving-fish.com/maimaidx/prober/ 注册并导入',
  '2. 已注册，但未在查分器内绑定该 QQ 号：',
  '   请在水鱼查分器官网的设置中绑定 QQ 号后重试',
  '也可以发送「#mai bind df」改用授权方式查询，不依赖查分器内的 QQ 号绑定。',
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
export function authorizeError(botName) {
  return `您尚未授权「${botName} BOT」访问您的落雪查分器数据，请先发送「#mai bind lxns」进行绑定。`
}

/**
 * 错误 → 用户可见文案；未知错误返回 null（调用方兜底）
 * @returns {string|null}
 */
export function errorMessage(error) {
  // 水鱼
  if (error instanceof DivingFishNotAuthorizedError) return NOTAUTHORIZED
  if (error instanceof DivingFishTooManyRequestsError) return '水鱼查分器请求次数已达上限，请稍后再试。'
  if (error instanceof DivingFishOAuthError) {
    logger.error('水鱼账号服务请求失败。')
    return '水鱼账号服务暂时不可用，请稍后再试。'
  }
  if (error instanceof DivingFishUserNotFoundError) return NOTFOUNDUSER
  if (error instanceof UserNotExistsError) return USER_NOT_EXISTS
  if (error instanceof DivingFishUserDisabledQueryError) return '该用户禁止了其他人获取数据或未同意用户协议。'
  if (error instanceof DivingFishTokenDisableError
    || error instanceof DivingFishTokenNotFoundError
    || error instanceof DivingFishTokenError) {
    logger.error('水鱼开发者Token异常，请自行检查。')
    return '请联系BOT管理员检查水鱼查分器相关信息，暂时无法查询。'
  }

  // 落雪
  if (error instanceof LXNSTokenError) return '落雪查分器授权错误，请尝试重新绑定授权。'
  if (error instanceof LXNSPermissionDeniedError) return LXNS_PERMISSION_DENIED
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
