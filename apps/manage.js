/**
 * #mai 更新 / 强制更新 / download（仅主人，参照 phi-plugin apps/update.js 范式精简实现）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * - 普通更新：git pull --no-rebase（本地改动冲突时报错并引导强制更新）
 * - 强制更新：fetch --all --prune → reset --hard origin/main → clean（保留静态资源/数据/用户配置）
 * - 下载资源：静态资源包 clone/update（详见 lib/resourcePack.js），
 *   对应 phi 的「下载曲绘」；插件更新后按 autoUpdateAssets 自动跟进，对应 autoPullPhiIll
 * - 更新成功回最近提交日志；git/remote 缺失给中文引导；执行中防重入
 * 提示：本仓库已配置 origin（https://github.com/Temmie0125/mai-plugin.git）
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import plugin from '../../../lib/plugins/plugin.js'
import Config, { head } from '../lib/config.js'
import { pluginRoot, staticRoot } from '../lib/path.js'
import { syncAssets, hasGit } from '../lib/resourcePack.js'

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
        // 资源包单独一条：带后缀的「更新资源/更新曲绘」不会被上面的更新规则吃掉，
        // 而 #mai sync 两条都不命中（同步曲库属 P3，见 docs/P3实施文档.md §3.5）
        { reg: `^[#/]${H()}\\s*(?:[Dd]ownload|[Dd]ownill|下载资源|下载|更新资源|更新曲绘)\\s*$`, fnc: 'downRes' },
      ],
    })
  }

  /** #mai 更新 / #mai 强制更新 */
  async update(e) {
    if (!e.isMaster) {
      await this.reply('该指令仅主人可用', true)
      return true
    }
    if (updating) {
      await this.reply('已有更新在执行中，请勿重复操作', true)
      return true
    }

    try {
      await git('git --version')
    } catch {
      await this.reply('未检测到 git，请先安装 git 后重试', true)
      return true
    }

    const force = ((e.msg.match(new RegExp(`^[#/]${H()}\\s*(强制)?\\s*(?:更新|gx|update)\\s*$`)) || [])[1] === '强制')

    // remote 就绪检查
    try {
      const remotes = await git(`git -C ${shellPath(pluginRoot)} remote`)
      if (!remotes.trim()) {
        await this.reply(
          `未配置远程仓库，请先执行：\ngit -C plugins/mai-plugin remote add origin ${REPO_URL}.git`,
          true,
        )
        return true
      }
    } catch (error) {
      await this.reply(`git remote 检查失败：${error.message}`, true)
      return true
    }

    await this.reply(force ? '开始执行强制更新（将放弃本地改动），请稍候…' : '开始拉取插件更新，请稍候…', true)
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
      await this.reply(this.gitErrText(error), true)
      return true
    }
    updating = false

    if (/Already up[ -]to[ -]date|已经是最新的/i.test(ret)) {
      const time = await this.lastCommitTime()
      await this.reply(`插件已经是最新版本\n最后提交时间：${time}`, true)
      await this.autoSyncAssets()
      return true
    }

    const time = await this.lastCommitTime()
    await this.reply(`插件更新完成\n最后提交时间：${time}`, true)
    if (oldCommit) {
      await this.commitLogs(oldCommit, e)
    }
    await this.reply('更新完成。若修改涉及命令/启动逻辑，请重启 Bot 生效（宿主热更不保证覆盖）。', true)
    await this.autoSyncAssets()
    return true
  }

  /** #mai download / 下载资源 / 更新资源：下载或更新静态资源包 */
  async downRes(e) {
    if (!e.isMaster) {
      await this.reply('该指令仅主人可用', true)
      return true
    }
    if (syncingRes) {
      await this.reply('资源更新已在执行中，请勿重复操作', true)
      return true
    }
    if (!(await hasGit())) {
      await this.reply('未检测到 git，请先安装 git 后重试', true)
      return true
    }

    await this.reply('开始下载/更新静态资源包，请稍候…（约 600MB，首次较慢）', true)
    await this.syncResourcePack()
    return true
  }

  /** 插件更新成功后按配置自动跟进资源包（对应 phi 的 autoPullPhiIll，默认开启） */
  async autoSyncAssets() {
    if (!Config.getUserCfg('config', 'autoUpdateAssets')) return
    if (!(await hasGit())) return
    await this.reply('按「自动更新资源」配置检查静态资源包…', true)
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
      await this.reply(this.gitErrText(error, '资源包'), true)
      return
    } finally {
      syncingRes = false
    }

    // 远端为空：clone 会成功但拿不到任何提交（见 lib/resourcePack.js 的 empty 说明）
    if (r.empty) {
      await this.reply(`远程资源仓库还没有 main 分支（资源尚未推送）。\n仓库地址：${r.url}`, true)
      return
    }
    if (!r.changed) {
      await this.reply(`静态资源包已是最新（曲绘 ${r.covers.after} 张）`, true)
      return
    }

    const verb = r.action === 'clone' ? '下载' : '更新'
    const added = r.covers.after - r.covers.before
    await this.reply(
      `静态资源包${verb}完成：曲绘 ${r.covers.before} → ${r.covers.after} 张（${added >= 0 ? '+' : ''}${added}）\n`
      + `耗时 ${(r.elapsedMs / 1000).toFixed(1)} 秒，资源来源 ${r.url}`,
      true,
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

  /** 自 oldCommit 起的新提交日志（合并提交跳过；合并转发失败降级文本） */
  async commitLogs(oldCommit, e) {
    let logAll
    try {
      logAll = await git(
        `git -C ${shellPath(pluginRoot)} log -20 --oneline --pretty=format:"%h||[%cd] %s" --date=format:"%m-%d %H:%M"`,
      )
    } catch (error) {
      logger?.error?.('[mai-plugin] 更新日志获取失败：', error.message)
      return
    }
    const log = []
    for (const line of logAll.split('\n')) {
      const [hash, rest] = line.split('||')
      if (hash === oldCommit) break
      if (!rest || rest.includes('Merge branch')) continue
      log.push(rest)
    }
    if (!log.length) return
    log.reverse()
    log.unshift(`更新日志，共 ${log.length} 条`)
    try {
      const common = (await import('../../../lib/common/common.js')).default
      const fwd = await common.makeForwardMsg(e, log)
      await this.reply(fwd, true)
    } catch {
      await this.reply(log.join('\n'), true)
    }
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
