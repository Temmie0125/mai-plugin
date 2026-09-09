/**
 * 客户端错误类型（源 core/clients/exceptions.py + divingfish/exceptions.py + lxns/exceptions.py 合并直译）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。错误名与源一一对应，供文案表映射。
 */

export class ApiError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ApiError'
  }
}

// ---- 通用 ----
export class UnknownError extends ApiError { constructor() { super('UnknownError'); this.name = 'UnknownError' } }
export class ServerError extends ApiError { constructor() { super('ServerError'); this.name = 'ServerError' } }
export class UserNotExistsError extends ApiError { constructor() { super('UserNotExistsError'); this.name = 'UserNotExistsError' } }
export class UserNotBindError extends ApiError { constructor() { super('UserNotBindError'); this.name = 'UserNotBindError' } }
export class MusicNotPlayError extends ApiError { constructor() { super('MusicNotPlayError'); this.name = 'MusicNotPlayError' } }
export class NotMusicRecommendationError extends ApiError { constructor() { super('NotMusicRecommendationError'); this.name = 'NotMusicRecommendationError' } }

// ---- 水鱼 ----
export class DivingFishTokenError extends ApiError { constructor() { super('DivingFishTokenError'); this.name = 'DivingFishTokenError' } }
export class DivingFishTokenDisableError extends ApiError { constructor() { super('DivingFishTokenDisableError'); this.name = 'DivingFishTokenDisableError' } }
export class DivingFishTokenNotFoundError extends ApiError { constructor() { super('DivingFishTokenNotFoundError'); this.name = 'DivingFishTokenNotFoundError' } }
export class DivingFishUserNotFoundError extends ApiError { constructor() { super('DivingFishUserNotFoundError'); this.name = 'DivingFishUserNotFoundError' } }
export class DivingFishUserDisabledQueryError extends ApiError { constructor() { super('DivingFishUserDisabledQueryError'); this.name = 'DivingFishUserDisabledQueryError' } }
export class DivingFishNotAuthorizedError extends ApiError { constructor() { super('DivingFishNotAuthorizedError'); this.name = 'DivingFishNotAuthorizedError' } }
export class DivingFishTooManyRequestsError extends ApiError { constructor() { super('DivingFishTooManyRequestsError'); this.name = 'DivingFishTooManyRequestsError' } }
export class DivingFishOAuthError extends ApiError { constructor() { super('DivingFishOAuthError'); this.name = 'DivingFishOAuthError' } }

// ---- 落雪 ----
export class LXNSTokenError extends ApiError { constructor() { super('LXNSTokenError'); this.name = 'LXNSTokenError' } }
export class LXNSOAuthError extends ApiError { constructor() { super('LXNSOAuthError'); this.name = 'LXNSOAuthError' } }
export class LXNSParamsError extends ApiError { constructor() { super('LXNSParamsError'); this.name = 'LXNSParamsError' } }
export class LXNSPermissionDeniedError extends ApiError { constructor() { super('LXNSPermissionDeniedError'); this.name = 'LXNSPermissionDeniedError' } }
export class LXNSNotFoundError extends ApiError { constructor() { super('LXNSNotFoundError'); this.name = 'LXNSNotFoundError' } }
export class LXNSTooManyRequestsError extends ApiError { constructor() { super('LXNSTooManyRequestsError'); this.name = 'LXNSTooManyRequestsError' } }

// ---- 柚子 ----
export class RequestError extends ApiError {
  constructor(data) {
    super('RequestError')
    this.name = 'RequestError'
    this.data = data
  }
}
