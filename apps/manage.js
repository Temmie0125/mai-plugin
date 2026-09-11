/**
 * #mai 更新 / 强制更新 / download（仅主人，参照 phi-plugin apps/update.js 范式精简实现）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * - 普通更新：git pull --no-rebase（本地改动冲突时报错并引导强制更新）
 * - 强制更新：fetch --all --prune → reset --hard origin/main → clean（保留静态资源/数据/用户配置）
 * - 下载资源：静态资源包 clone/update（详见 lib/resourcePack.js），
 *   对应 phi 的「下载曲绘」；插件更新后按 autoUpdateAssets 自动跟进，对应 autoPullPhiIll
 * - 同步曲库：`#mai sync` 与每日定时 task 共用 lib/sync.js 的同一把锁（P3 实施文档 §3）
 * - 更新成功回最近提交日志（合并转发不支持引用回复，一律不引用，避免多发一条空引用消息）；
 *   对齐 phi-plugin 的重启判断：提交信息带 √/✓ 视为热更安全，否则更新完毕自动重启宿主；
 *   git/remote 缺失给中文引导；执行中防重入
 * 提示：本仓库已配置 origin（https://github.com/Temmie0125/mai-plugin.git）
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import plugin from '../../../lib/plugins/plugin.js'
import Config, { head } from '../lib/config.js'
import { pluginRoot, staticRoot } from '../lib/path.js'
import { syncAssets, hasGit } from '../lib/resourcePack.js'
import { syncMusicData, isSyncing } from '../lib/sync.js'
import { resolveAutoSyncCron } from '../lib/schedule.js'
import { handleErrors } from '../lib/handlerError.js'
import { mai } from '../lib/service.js'

const execAsync = promisify(exec)
const REPO_URL = 'https://github.com/Temmie0125/mai-plugin'

/** 强制更新时 clean 的保留项（gitignored 运行产物/用户数据/本地测试不入库内容不删；clean -e 匹配仓库根相对路径） */
const CLEAN_KEEP = ['resources/static', 'data', 'config/config', 'tests', 'temp']

const H = () => head()

let updating = false
/** 资源包同步锁：与 updating 分开——资源包与插件是两个仓库，且插件更新后的自动同步不能撞上自己的锁 */
let syncingRes = false

function shellPath(p) {
  return `"${p.replace(/\\/g, '/').replace(/"/g, '\\"')}"`
}

async function git(cmd, { timeout = 120000 } = {}) {
  const { stdout, stderr } = await execAsync(cmd, { timeout, windowsHide: true, encoding: 'utf8' })
  return stdout + (stderr || '')
}

export class MaiManage extends plugin {
  constructor() {
    super({
      name: 'mai-manage',
      dsc: '舞萌DX管理',
      event: 'message',
      priority: 100,
      rule: [
        { reg: `^[#/]${H()}\\s*(强制)?\\s*(?:更新|gx)\\s*$`, fnc: 'update' },
        // 资源包单独一条：带后缀的「更新资源/更新曲绘」不会被上面的更新规则吃掉
        { reg: `^[#/]${H()}\\s*(?:[Dd]ownload|[Dd]ownill|下载资源|下载|更新资源|更新曲绘)\\s*$`, fnc: 'downRes' },
        // 同步曲库（P3 §3.5）：刻意避开 update 一词——phi 的 #phi update 是「用户拉自己的成绩」，
        // 同宿主共存时语义会混。三条规则互不吃，由 tests/manage.test.js 锁定。
        { reg: `^[#/]${H()}\\s*(?:sync|更新曲库|数据更新)\\s*$`, fnc: 'syncMusic' },
      ],
    })
  }

  /**
   * 定时任务装配点（宿主 loader 先跑 init 再 collectTask，且此刻配置才可读）。
   * init() 只在插件加载时跑一次 ⇒ 配置改动天然「重启生效」，正是本项目要的语义。
   * 宿主 plugin.js 已给 this.task 赋了 `{name:'',fnc:'',cron:''}` 占位，而 collectTask 判的是
   * `if (i.cron && i.fnc)`（空串为假）⇒ autoSync 关闭时不覆盖即天然不注册。
   */
  async init() {
    const cfg = Config.getUserCfg('config')
    if (!cfg.autoSync) return // 不覆盖 this.task 的占位对象 ⇒ collectTask 不注册
    const { cron, time, fallback } = resolveAutoSyncCron(cfg.autoSyncTime)
    if (fallback) {
      logger?.error?.(
        `[mai-plugin] autoSyncTime 非法：${JSON.stringify(cfg.autoSyncTime)}，已回退默认 ${time}`,
      )
    }
    this.task = { name: 'mai-plugin-曲库同步', cron, fnc: () => this.autoSync(), log: false }
    // 成功路径不在这里打日志：index.js 的启动块已统一打印实际生效的同步计划（P3 §10.3），
    // 两处都打会让启动日志出现两行几乎相同的内容
  }

  /** #mai sync / 更新曲库 / 数据更新 —— 全量同步曲库/别名/牌子（仅主人） */
  async syncMusic(e) {
    if (!e.isMaster) {
      await this.reply('该指令仅主人可用')
      return true
    }
    if (isSyncing()) {
      await this.reply('正在同步中，请稍候')
      return true
    }

    await this.reply('正在同步曲库…')
    // handleErrors：成功返回原值，失败返回可发送的中文文案（lib/handlerError.js）
    const r = await handleErrors(() => syncMusicData())
    if (typeof r === 'string') {
      await this.reply(r)
      return true
    }
    if (r?.busy) {
      await this.reply('正在同步中，请稍候')
      return true
    }
    await this.reply(
      `曲库/别名/牌子同步完成（曲库 ${mai.totalList.root.length} 曲 / 别名 ${mai.totalAliasList.root.length} 条）`,
    )
    return true
  }

  /**
   * 每日定时任务入口（宿主 task 的 fnc 不带任何参数，故无 `e`）
   * 忙则跳过本轮并记日志；失败记日志并通知主人——每日数据刷新静默失败是运维陷阱。
   */
  async autoSync() {
    const busy = () => logger?.mark?.('[mai-plugin] 曲库同步进行中，跳过本轮定时同步')
    if (isSyncing()) {
      busy()
      return
    }
    try {
      const r = await syncMusicData()
      if (r?.busy) {
        busy()
        return
      }
      logger?.mark?.(
        `[mai-plugin] 定时同步完成：曲库 ${mai.totalList.root.length} 曲 / 别名 ${mai.totalAliasList.root.length} 条`,
      )
    } catch (error) {
      const msg = error?.message || String(error)
      logger?.error?.('[mai-plugin] 定时同步曲库失败：', msg)
      try {
        await globalThis.Bot?.sendMasterMsg?.(
          `[mai-plugin] 每日自动同步曲库失败：${msg}\n可发送「#${H()} sync」手动重试。`,
        )
      } catch { /* 通知失败不影响任务本身 */ }
    }
  }

  /** #mai 更新 / #mai 强制更新 */
  async update(e) {
    if (!e.isMaster) {
      await this.reply('该指令仅主人可用')
      return true
    }
    if (updating) {
      await this.reply('已有更新在执行中，请勿重复操作')
      return true
    }

    try {
      await git('git --version')
    } catch {
      await this.reply('未检测到 git，请先安装 git 后重试')
      return true
    }

    const force = ((e.msg.match(new RegExp(`^[#/]${H()}\\s*(强制)?\\s*(?:更新|gx|update)\\s*$`)) || [])[1] === '强制')

    // remote 就绪检查
    try {
      const remotes = await git(`git -C ${shellPath(pluginRoot)} remote`)
      if (!remotes.trim()) {
        await this.reply(
          `未配置远程仓库，请先执行：\ngit -C plugins/mai-plugin remote add origin ${REPO_URL}.git`,
        )
        return true
      }
    } catch (error) {
      await this.reply(`git remote 检查失败：${error.message}`)
      return true
    }

    await this.reply(force ? '开始执行强制更新（将放弃本地改动），请稍候…' : '开始拉取插件更新，请稍候…')
    updating = true

    const root = shellPath(pluginRoot)
    let oldCommit
    try {
      oldCommit = (await git(`git -C ${root} rev-parse --short HEAD`)).trim()
    } catch { /* 获取失败则日志区整段展示 */ }

    const cleanKeep = CLEAN_KEEP.map(p => `-e ${p}`).join(' ')
    const command = force
      ? [
        `git -C ${root} fetch --all --prune`,
        `git -C ${root} reset --hard origin/main`,
        `git -C ${root} clean -fd ${cleanKeep}`,
      ].join(' && ')
      : `git -C ${root} pull --no-rebase`

    let ret
    try {
      ret = await git(command)
    } catch (error) {
      updating = false
      await this.reply(this.gitErrText(error))
      return true
    }
    updating = false

    if (/Already up[ -]to[ -]date|已经是最新的/i.test(ret)) {
      const time = await this.lastCommitTime()
      await this.reply(`插件已经是最新版本\n最后提交时间：${time}`)
      await this.autoSyncAssets()
      return true
    }

    const time = await this.lastCommitTime()
    await this.reply(`插件更新完成\n最后提交时间：${time}`)
    // oldCommit 取不到 ⇒ 改动范围未知，按需重启兜底
    let needRestart = !oldCommit
    if (oldCommit) {
      needRestart = await this.commitLogs(oldCommit, e)
    }
    await this.autoSyncAssets()
    // 对齐 phi-plugin：新提交全带 √/✓ 标记则热更即可，否则自动重启宿主应用更新
    if (needRestart) {
      if (this.restart()) {
        await this.reply('更新完毕，正在重启云崽以应用更新')
      } else {
        await this.reply('更新完毕。宿主不支持自动重启，请手动重启 Bot 生效。')
      }
    } else {
      await this.reply('更新完毕，本次更新不需要进行重启')
    }
    return true
  }

  /** 重启宿主 Bot（TRSS-Yunzai 的 Bot.restart 会先落盘 redis 再退出进程；2 秒缓冲让回执先送达） */
  restart() {
    if (!globalThis.Bot?.restart) return false
    setTimeout(() => globalThis.Bot.restart(), 2000)
    return true
  }

  /** #mai download / 下载资源 / 更新资源：下载或更新静态资源包 */
  async downRes(e) {
    if (!e.isMaster) {
      await this.reply('该指令仅主人可用')
      return true
    }
    if (syncingRes) {
      await this.reply('资源更新已在执行中，请勿重复操作')
      return true
    }
    if (!(await hasGit())) {
      await this.reply('未检测到 git，请先安装 git 后重试')
      return true
    }

    await this.reply('开始下载/更新静态资源包，请稍候…（约 600MB，首次较慢）')
    await this.syncResourcePack()
    return true
  }

  /** 插件更新成功后按配置自动跟进资源包（对应 phi 的 autoPullPhiIll，默认开启） */
  async autoSyncAssets() {
    if (!Config.getUserCfg('config', 'autoUpdateAssets')) return
    if (!(await hasGit())) return
    await this.reply('按「自动更新资源」配置检查静态资源包…')
    await this.syncResourcePack()
  }

  /**
   * 资源包同步执行体（命令与自动跟进共用）
   * 失败一律转中文回执、不向上冒泡，避免中断调用方（插件更新）的后续流程
   * @param {string} [dir] 资源包目录，默认 resources/static（测试注入临时目录用）
   */
  async syncResourcePack(dir = staticRoot) {
    syncingRes = true
    let r
    try {
      r = await syncAssets({ dir })
    } catch (error) {
      await this.reply(this.gitErrText(error, '资源包'))
      return
    } finally {
      syncingRes = false
    }

    // 远端为空：clone 会成功但拿不到任何提交（见 lib/resourcePack.js 的 empty 说明）
    if (r.empty) {
      await this.reply(`远程资源仓库还没有 main 分支（资源尚未推送）。\n仓库地址：${r.url}`)
      return
    }
    if (!r.changed) {
      await this.reply(`静态资源包已是最新（曲绘 ${r.covers.after} 张）`)
      return
    }

    const verb = r.action === 'clone' ? '下载' : '更新'
    const added = r.covers.after - r.covers.before
    await this.reply(
      `静态资源包${verb}完成：曲绘 ${r.covers.before} → ${r.covers.after} 张（${added >= 0 ? '+' : ''}${added}）\n`
      + `耗时 ${(r.elapsedMs / 1000).toFixed(1)} 秒，资源来源 ${r.url}`,
    )
  }

  async lastCommitTime() {
    try {
      const out = await git(
        `git -C ${shellPath(pluginRoot)} log -1 --pretty=format:"%cd" --date=format:"%m-%d %H:%M"`,
      )
      return out.trim() || '获取时间失败'
    } catch {
      return '获取时间失败'
    }
  }

  /**
   * 自 oldCommit 起的新提交日志（合并提交跳过；合并转发失败降级文本）
   * 对齐 phi-plugin 的重启判断：提交信息带 √/✓ 视为热更安全（资源/数据类改动），
   * 只要有一条新提交未标记，就返回 true（需重启生效）。
   * @param {string} [dir] 插件仓库目录（默认 pluginRoot，测试注入临时仓库用）
   * @returns {Promise<boolean>} 是否需要重启 Bot 应用本次更新
   */
  async commitLogs(oldCommit, e, dir = pluginRoot) {
    let logAll
    try {
      logAll = await git(
        `git -C ${shellPath(dir)} log -20 --oneline --pretty=format:"%h||[%cd] %s" --date=format:"%m-%d %H:%M"`,
      )
    } catch (error) {
      logger?.error?.('[mai-plugin] 更新日志获取失败：', error.message)
      return false
    }
    let needRestart = false
    const log = []
    for (const line of logAll.split('\n')) {
      const [hash, rest] = line.split('||')
      if (hash === oldCommit) break
      if (!rest || rest.includes('Merge branch')) continue
      log.push(rest)
      if (!(rest.includes('√') || rest.includes('✓'))) needRestart = true
    }
    if (!log.length) return false
    log.reverse()
    log.unshift(`更新日志，共 ${log.length} 条`)
    try {
      const common = (await import('../../../lib/common/common.js')).default
      // 合并转发不支持引用回复：带引用会多发一条空引用消息
      const fwd = await common.makeForwardMsg(e, log)
      await this.reply(fwd)
    } catch {
      await this.reply(log.join('\n'))
    }
    return needRestart
  }

  /**
   * 更新失败中文分流（参照 phi-plugin gitErr 精简；插件更新与资源包同步共用）
   * @param {Error} error
   * @param {'插件'|'资源包'} what 失败主体——两者的补救手段不同（插件可强制更新，资源包只能换源/重试）
   */
  gitErrText(error, what = '插件') {
    const msg = error?.message || String(error)
    const out = `${what}更新失败：`
    const isPlugin = what === '插件'
    // 资源仓库推送前的首跑路径：远端无 main 分支
    if (/couldn't find remote ref|Remote branch .+ not found|empty repository/i.test(msg)) {
      return `${out}远程仓库还没有 main 分支（仓库为空或资源尚未推送）。\n请先向资源仓库推送内容，或改用其它地址（配置项 assetsRepo）。`
    }
    if (/Timed out|Failed to connect|unable to access|Could not resolve/i.test(msg)) {
      return `${out}连接远程仓库失败（超时或网络不通）。\n可稍后重试`
        + (isPlugin ? '，或使用「强制更新」。' : '；GitHub 直连不畅时可把 assetsRepo 改填代理前缀地址。')
    }
    if (/be overwritten by merge|CONFLICT|Your local changes/i.test(msg)) {
      return `${out}存在本地改动冲突：\n${msg.slice(0, 400)}\n`
        + (isPlugin ? '可放弃本地改动执行「强制更新」，或手动解决冲突。' : '请先手动处理 resources/static 内的冲突。')
    }
    if (/no remote|without a remote|repository .* does not exist|not a git repository/i.test(msg)) {
      return `${out}git 仓库/远程异常：\n${msg.slice(0, 300)}`
    }
    return `${out}\n${msg.slice(0, 500)}`
  }
}
