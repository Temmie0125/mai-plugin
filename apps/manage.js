/**
 * #mai 更新 / 强制更新（仅主人，参照 phi-plugin apps/update.js 范式精简实现）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 * - 普通更新：git pull --no-rebase（本地改动冲突时报错并引导强制更新）
 * - 强制更新：fetch --all --prune → reset --hard origin/main → clean（保留静态资源/数据/用户配置）
 * - 更新成功回最近提交日志；git/remote 缺失给中文引导；执行中防重入
 * 提示：本仓库已配置 origin（https://github.com/Temmie0125/mai-plugin.git）
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import plugin from '../../../lib/plugins/plugin.js'
import { head } from '../lib/config.js'
import { pluginRoot } from '../lib/path.js'

const execAsync = promisify(exec)
const REPO_URL = 'https://github.com/Temmie0125/mai-plugin'

/** 强制更新时 clean 的保留项（gitignored 运行产物/用户数据/本地测试不入库内容不删；clean -e 匹配仓库根相对路径） */
const CLEAN_KEEP = ['resources/static', 'data', 'config/config', 'tests', 'temp']

const H = () => head()

let updating = false

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
        { reg: `^[#/]${H()}\\s*(强制)?\\s*(?:更新|gx|update)\\s*$`, fnc: 'update' },
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
      return true
    }

    const time = await this.lastCommitTime()
    await this.reply(`插件更新完成\n最后提交时间：${time}`, true)
    if (oldCommit) {
      await this.commitLogs(oldCommit, e)
    }
    await this.reply('更新完成。若修改涉及命令/启动逻辑，请重启 Bot 生效（宿主热更不保证覆盖）。', true)
    return true
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

  /** 更新失败中文分流（参照 phi-plugin gitErr 精简） */
  gitErrText(error) {
    const msg = error?.message || String(error)
    const out = '插件更新失败：'
    if (/Timed out|Failed to connect|unable to access|Could not resolve/i.test(msg)) {
      return `${out}连接远程仓库失败（超时或网络不通）。\n可稍后重试，或使用「#mai 强制更新」。`
    }
    if (/be overwritten by merge|CONFLICT|Your local changes/i.test(msg)) {
      return `${out}存在本地改动冲突：\n${msg.slice(0, 400)}\n可放弃本地改动执行「#mai 强制更新」，或手动解决冲突。`
    }
    if (/no remote|without a remote|repository .* does not exist|not a git repository/i.test(msg)) {
      return `${out}git 仓库/远程异常：\n${msg.slice(0, 300)}`
    }
    return `${out}\n${msg.slice(0, 500)}`
  }
}
