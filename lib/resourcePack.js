/**
 * 静态资源包 git 管理单点（`#mai download` 与插件更新后的自动更新）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 *
 * 与 apps/manage.js 的插件自更新同范式（remote → fetch → reset --hard），三处有意差异：
 * - 就地收编：README 主推路径是用户先把 NoneBot 资源包手工复制进 resources/static/，
 *   对这种「有内容但无 .git」的目录就地 init 后对齐远端，避免白下 600MB
 * - 浅克隆（--depth=1）：资源包体积大且无历史回溯需求
 * - 不执行 git clean：resources/static/data/ 可能留有迁移用户的 user.db 与曲库 JSON
 *
 * 远端为空（尚无 main 分支）时 clone 本身不报错、update 会抛 couldn't find remote ref，
 * 两种结果都由调用方经 gitErrText 转成中文引导。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import Config from './config.js'
import { staticRoot } from './path.js'
import { checkReadiness } from './render/assets.js'

const execFileAsync = promisify(execFile)

/** 出厂资源仓库（config.assetsRepo 留空时回退到它） */
export const DEFAULT_ASSETS_REPO = 'https://github.com/Temmie0125/mai-plugin-resource-static.git'

/** clone/fetch 在慢网下可能数分钟；git --progress 输出也远超 execFile 默认 1MB 上限 */
const GIT_TIMEOUT = 30 * 60 * 1000
const GIT_MAX_BUFFER = 32 * 1024 * 1024

/**
 * 执行 git 子命令（execFile：不经 shell，路径含空格/中文无需转义）
 * 用 GIT_TERMINAL_PROMPT/GCM_INTERACTIVE 关掉凭据交互，避免无人值守时挂死到超时
 */
async function git(args) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    timeout: GIT_TIMEOUT,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  })
  return `${stdout || ''}${stderr || ''}`
}

/** git 是否可用（与 apps/manage.js 同判据） */
export async function hasGit() {
  try {
    return (await git(['--version'])).includes('git version')
  } catch {
    return false
  }
}

/** 资源包仓库地址：用户配置优先，留空/非法值回退出厂默认 */
export function assetsRepoUrl() {
  const raw = Config.getUserCfg('config', 'assetsRepo')
  return String(raw ?? '').trim() || DEFAULT_ASSETS_REPO
}

/**
 * 同步动作决策（纯函数，便于单测）
 * @param {string} [dir] 资源包目录
 * @returns {'clone'|'adopt'|'update'} 无 .git 且目录非空 → 就地收编；有 .git → 更新；其余 → 克隆
 */
export function planSync(dir = staticRoot) {
  if (fs.existsSync(path.join(dir, '.git'))) return 'update'
  try {
    if (fs.readdirSync(dir).length) return 'adopt'
  } catch {
    /* 目录不存在：按克隆处理 */
  }
  return 'clone'
}

/** 当前 HEAD 短 id；无提交（空仓库/空远端克隆）时为 null */
async function revParse(dir) {
  try {
    return (await git(['-C', dir, 'rev-parse', '--short', 'HEAD'])).trim()
  } catch {
    return null
  }
}

/** 让 origin 指向当前配置的地址（跟随 assetsRepo 变更；不存在则新增） */
async function ensureRemote(dir, url) {
  let exists = true
  try {
    await git(['-C', dir, 'remote', 'get-url', 'origin'])
  } catch {
    exists = false
  }
  await git(['-C', dir, 'remote', exists ? 'set-url' : 'add', 'origin', url])
}

/**
 * 下载/更新静态资源包（幂等：已是最新时不改动工作区）
 * @param {{ dir?: string }} [opts]
 * @returns {Promise<{action: string, url: string, before: string|null, after: string|null,
 *   changed: boolean, empty: boolean, covers: {before: number, after: number}, elapsedMs: number}>}
 *   empty=true 表示远端尚无内容（clone 成功但拿不到任何提交）
 */
export async function syncAssets({ dir = staticRoot } = {}) {
  const url = assetsRepoUrl()
  const action = planSync(dir)
  const startedAt = Date.now()
  const coversBefore = checkReadiness(dir).count
  const before = await revParse(dir)

  if (action === 'clone') {
    // 不带 --branch：远端为空时 clone --branch main 会直接 fatal，而裸 clone 只警告
    // （留下空 .git，用户推送资源后下次自动转入 update 分支自愈）
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    await git(['clone', '--depth=1', url, dir])
  } else {
    if (action === 'adopt') {
      await git(['init', dir])
      // 用 symbolic-ref 而非 git init -b，避开 git < 2.28 不支持 -b
      await git(['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    }
    await ensureRemote(dir, url)
    // --depth=1 下用 FETCH_HEAD 而非 origin/main（远端跟踪引用在浅取时未必建立）
    await git(['-C', dir, 'fetch', '--depth=1', 'origin', 'main'])
    await git(['-C', dir, 'reset', '--hard', 'FETCH_HEAD'])
  }

  const after = await revParse(dir)
  return {
    action,
    url,
    before,
    after,
    changed: after !== before,
    empty: after === null,
    covers: { before: coversBefore, after: checkReadiness(dir).count },
    elapsedMs: Date.now() - startedAt,
  }
}
