/**
 * mai-plugin 入口（设计 §2.2/§10.1，ADR-2/9）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN，https://github.com/Yuri-YuzuChaN/nonebot-plugin-maimaidx）
 * 及上游 mai-bot 项目的美术设计，仅作信息级还原复用，相关权利归原作者所有。
 *
 * 启动序列（源 __init__.py:35-101 逐段对应）：
 *   1. config.init（yaml 双轨）  2. database.load（user/group.json）
 *   3. 曲库加载（P1：data/music/ 缓存 → static/data 导入 → 联网重建）
 *   4. 资源包就绪检测 + 配置三级告警
 *   5. 动态 import apps/ 并 export { apps }（宿主 loader 展开）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Config from './lib/config.js'
import * as database from './lib/database.js'
import { checkReadiness } from './lib/render/assets.js'
import pkg from './package.json' with { type: 'json' }
const { version } = pkg

// 1) 配置初始化（构造时已完成 default_config → config 复制）
Config.initCfg()

// 2) 用户/群数据载入
await database.load()

// 3) 曲库加载（P1 接入：mai.getMusic → getMusicAlias → getPlateJson，失败 lazy 重试）
// TODO(P1): data/music/ 缓存加载与增量校验

const logger = global.logger || console

logger.mark('-------mai-plugin-------')

// 4) 资源包就绪检测（设计 §9.1）
const ready = checkReadiness()
if (!ready.ready) {
  logger.error(
    `[mai-plugin] 静态资源包缺失或曲绘不足（${ready.count}/500+），` +
      '请将 NoneBot 资源包 static/ 整体复制到 plugins/mai-plugin/resources/static/，' +
      '或按 README 下载资源包解压。'
  )
} else {
  logger.mark(`[mai-plugin] 静态资源就绪：曲绘 ${ready.count} 张`)
}

// 4.1) 配置三级告警（源 __init__.py:63-101 对应，P0 先做 P2 相关项）
const cfg = Config.getUserCfg('config')
if (!cfg.dfClientId || !cfg.dfClientSecret) {
  logger.warn('[mai-plugin] 未配置水鱼查分器 OAuth 应用（dfClientId/dfClientSecret），绑定水鱼不可用，查分模块将只能使用 b50')
}
if (!cfg.lxnsDevToken) {
  logger.warn('[mai-plugin] 未配置落雪查分器开发者 Token（lxnsDevToken），无法使用落雪数据源')
}
if (!cfg.lxClientId || !cfg.lxClientSecret || !cfg.lxRedirectUri) {
  logger.warn('[mai-plugin] 未配置落雪 OAuth 应用（lxClientId/lxClientSecret/lxRedirectUri），绑定落雪不可用')
}
if (cfg.aliasPush) {
  logger.mark('[mai-plugin] 别名推送为「开启」状态')
} else {
  logger.warn('[mai-plugin] 别名推送为「关闭」状态')
}

// 5) 动态加载 apps/（phi-plugin index.js 范式；类实例化两次，构造器保持幂等）
const appsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'apps')
const files = fs.readdirSync(appsDir).filter(file => file.endsWith('.js'))

const results = await Promise.allSettled(files.map(file => import(`./apps/${file}`)))

/** @type {Record<string, any>} */
let apps = {}
for (const [i, file] of files.entries()) {
  const ret = results[i]
  if (ret.status !== 'fulfilled') {
    logger.error(`[mai-plugin] 加载 apps/${file} 失败`, ret.reason)
    continue
  }
  const mod = ret.value
  const key = file.replace('.js', '')
  // 每个文件导出一个 class extends plugin
  apps[key] = mod[Object.keys(mod)[0]]
}

logger.mark(`[mai-plugin] v${version} 载入完成 · 命令头「${Config.getUserCfg('config', 'cmdhead')}」`)
logger.mark('[mai-plugin] 移植自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）· 上游 mai-bot')

export { apps }
