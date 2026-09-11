/**
 * 错误文案表（lib/handlerError.js）用户侧引导锁值
 *
 * 两条按用户反馈强化的文案：
 * - 水鱼按 QQ 代查 "user not exists"（b50 等自查命令的主报错）：服务端区分不了
 *   「未注册水鱼」与「已注册但查分器内没绑 QQ 号」，两种成因并列引导，并给出
 *   OAuth 授权（bind df）这条不依赖查分器内 QQ 绑定的替代查询路径；
 * - 落雪 403：玩家侧隐私设置三选项是高频成因，排在 BOT 管理员排查之前。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('水鱼 user not exists：双成因引导 + bind df 替代路径', async () => {
  const { errorMessage, USER_NOT_EXISTS } = await import('../lib/handlerError.js')
  const { UserNotExistsError } = await import('../lib/client/errors.js')
  assert.equal(errorMessage(new UserNotExistsError()), USER_NOT_EXISTS)
  assert.match(USER_NOT_EXISTS, /未在水鱼查分器找到该 QQ 号对应的玩家/)
  assert.match(USER_NOT_EXISTS, /注册水鱼查分器或未导入成绩/)
  assert.match(USER_NOT_EXISTS, /diving-fish\.com\/maimaidx\/prober\//)
  assert.match(USER_NOT_EXISTS, /未在查分器内绑定该 QQ 号/)
  assert.match(USER_NOT_EXISTS, /#mai bind df[\s\S]*不依赖查分器内的 QQ 号绑定/)
})

test('落雪 403：隐私三选项在前、BOT 侧令牌排查在后', async () => {
  const { errorMessage, LXNS_PERMISSION_DENIED } = await import('../lib/handlerError.js')
  const { LXNSPermissionDeniedError } = await import('../lib/client/errors.js')
  assert.equal(errorMessage(new LXNSPermissionDeniedError()), LXNS_PERMISSION_DENIED)
  assert.match(LXNS_PERMISSION_DENIED, /账号设置 → 隐私设置/)
  for (const opt of ['允许读取玩家信息', '允许读取谱面成绩', '允许读取历史成绩']) {
    assert.ok(LXNS_PERMISSION_DENIED.includes(opt), `缺少选项：${opt}`)
  }
  assert.ok(
    LXNS_PERMISSION_DENIED.indexOf('允许读取玩家信息') < LXNS_PERMISSION_DENIED.indexOf('BOT 管理员'),
    '玩家侧自查应排在管理员排查之前',
  )
})

test('既有映射不受影响：错误类别仍各归其位', async () => {
  const { errorMessage, NOTFOUNDUSER, NOTAUTHORIZED } = await import('../lib/handlerError.js')
  const {
    DivingFishUserNotFoundError, DivingFishNotAuthorizedError, MusicNotPlayError,
  } = await import('../lib/client/errors.js')
  assert.equal(errorMessage(new DivingFishUserNotFoundError()), NOTFOUNDUSER)
  assert.equal(errorMessage(new DivingFishNotAuthorizedError()), NOTAUTHORIZED)
  assert.equal(errorMessage(new MusicNotPlayError()), '您未游玩过曲目。')
})
