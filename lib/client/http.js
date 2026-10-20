/**
 * HTTP 基建（源 core/clients/http.py ApiClient → fetch 直译，设计 §七）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * - AbortController 超时（默认 60s；kwargs.timeout 可单请求覆盖）
 * - 幂等 GET 网络错误重试 ×1（退避 300ms）；超时不重试（慢服务器上重试只会翻倍等待）
 * - 401 → _onUnauthorized() 钩子（LXNS 401 自动刷新重试一次）
 */
import { ApiError, TimeoutError } from './errors.js'

const UA = 'mai-plugin/TRSS-Yunzai (port of nonebot-plugin-maimaidx)'

/** body 读取限时（timeout 单位 ms；不传则维持源语义不加限） */
function readBodyWithTimeout(resp, timeout) {
  if (!timeout) return resp.text()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`响应读取超时（${timeout}ms 内未读完）`)), timeout)
    resp.text().then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

export class ApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {Record<string, string>} [opts.headers]
   * @param {number} [opts.timeout] 毫秒（可被单次请求的 kwargs.timeout 覆盖）
   */
  constructor({ baseUrl, headers = {}, timeout = 60000 }) {
    this.baseUrl = baseUrl
    this.headers = headers
    this.timeout = timeout
  }

  async _fetch(method, endpoint, kwargs = {}) {
    let url = this.baseUrl + endpoint
    if (kwargs.params) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(kwargs.params)) qs.append(k, String(v))
      url += (url.includes('?') ? '&' : '?') + qs.toString()
    }
    const timeout = kwargs.timeout ?? this.timeout
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeout)
    /**
     * 外部 signal（长连接用：SSE 要能主动断开，而超时用的 controller 只覆盖「连接+响应头」，
     * 拿到响应头后就 clearTimeout 了、之后再也掐不断）。
     * ⚠️ 监听器**刻意不在 finally 里摘除**：`_fetch` 返回 Response 后调用方还要读 body，
     * 而 `finally` 在响应头到达时就已执行——摘了就等于外部 signal 之后失效。
     * 每个连接一个 signal，随连接对象一起回收，不会累积。
     */
    const external = kwargs.signal
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const init = {
        method,
        headers: { 'User-Agent': UA, ...(this.headers || {}), ...(kwargs.headers || {}) },
        signal: controller.signal,
      }
      if (kwargs.json !== undefined) {
        init.body = JSON.stringify(kwargs.json)
        init.headers['Content-Type'] = 'application/json'
      } else if (kwargs.form !== undefined) {
        // OAuth 端点均为 form-urlencoded 体（水鱼 device_authorization/oauth/token 等）
        const qs = new URLSearchParams()
        for (const [k, v] of Object.entries(kwargs.form)) qs.append(k, String(v))
        init.body = qs.toString()
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
      return await fetch(url, init)
    } catch (error) {
      // 到点未收到响应 → 转译成 TimeoutError：文案可读，且 _request 据此不做无谓重试
      if (timedOut) throw new TimeoutError(`请求超时（${timeout}ms 内未收到响应）`)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 请求并返回解析后的 JSON（源 _request：401 → 钩子刷新 → 单次重试）
   * @returns {Promise<any>}
   */
  async _request(method, endpoint, kwargs = {}) {
    const run = () => this._fetch(method, endpoint, kwargs)

    let resp
    try {
      resp = await run()
    } catch (error) {
      // 超时原样抛出、不重试：服务器慢到超时，紧跟着再发一次只会把调用方的等待翻倍
      if (error instanceof TimeoutError) throw error
      if (method === 'GET') {
        await new Promise(r => setTimeout(r, 300))
        resp = await run()
      } else {
        throw new ApiError(`网络请求失败：${error.message}`)
      }
    }

    if (resp.status === 401) {
      const handled = await this._onUnauthorized()
      if (handled) resp = await run()
    }

    await this._handleError(resp)
    // body 阶段单独限时：上面 _fetch 的超时只覆盖「连接+响应头」（见其注释），
    // 响应头到达后 body 挂起同样会卡死交互式调用方。给了显式 kwargs.timeout 才启用
    // （默认 60s 的常规接口维持源语义，只限响应头）；SSE 长连接不经此路，不受影响
    const text = await readBodyWithTimeout(resp, kwargs.timeout)
    try {
      return text ? JSON.parse(text) : {}
    } catch {
      throw new ApiError(`响应不是有效 JSON：${text.slice(0, 120)}`)
    }
  }

  async _onUnauthorized() {
    return false
  }

  /** 非 2xx 时抛对应错误（子类实现可为 async） */
  async _handleError(/** resp */) {
    throw new Error('not implemented')
  }
}

/** QQ 头像直链（模板 <img> 直接引用，源 qqlogo 的 URL 形态） */
export function qqLogoUrl(qqid) {
  return `https://q1.qlogo.cn/g?b=qq&nk=${qqid}&s=100`
}

/** 柚子在线素材直链（源 online_assets 的 URL 形态，plate/icon 收藏品切图） */
export function onlineAssetUrl(endpoint) {
  return `https://www.yuzuchan.moe/assets/maimaidx${endpoint}`
}
