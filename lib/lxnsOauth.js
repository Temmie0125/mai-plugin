/**
 * 落雪 OAuth 纯函数（源 core/lxns_oauth.py 直译，设计 §4.1）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * 等待登记（PendingBindingStore）由宿主 setContext 承担（用户级隔离 + 10min 超时），
 * 此处只保留：授权 URL 构造、授权码提取/校验、绑定频道门卫。
 */

/** 授权码真实形态（源 lxns_oauth.py:6-9，勿自造） */
export const AUTHORIZATION_CODE_PATTERN =
  /^(?:[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}|[A-Za-z0-9_-]{16,256})$/

/** 构造授权 URL（query 键序与源 urlencode 一致） */
export function buildAuthorizeUrl(clientId, redirectUri) {
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read_player read_user_profile write_player',
  })
  return `https://maimai.lxns.net/oauth/authorize?${qs.toString()}`
}

/**
 * 授权码提取：裸码 / 「授权码[:：]前缀」/ 完整回调 URL（code 查询参）
 * @returns {string|null}
 */
export function extractAuthorizationCode(text) {
  const value = String(text).trim()
  if (AUTHORIZATION_CODE_PATTERN.test(value)) return value

  const prefixed = value.match(/^授权码\s*[:：]?\s*(\S+)/)
  if (prefixed) {
    const code = prefixed[1]
    if (AUTHORIZATION_CODE_PATTERN.test(code)) return code
  }

  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const code = parsed.searchParams.get('code')
      if (code && AUTHORIZATION_CODE_PATTERN.test(code)) return code
    }
  } catch { /* 非 URL，忽略 */ }

  return null
}

/** 绑定频道门卫（源 is_binding_channel_allowed）：private_only 时仅私聊可绑 */
export function isBindingChannelAllowed({ privateOnly, isPrivate }) {
  return isPrivate || !privateOnly
}
