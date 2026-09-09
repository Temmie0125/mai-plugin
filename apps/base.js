/**
 * #mai 基命令：帮助图 / 无子命令兜底提示（设计 §3.2-2）
 * 视觉设计派生自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）及上游 mai-bot
 */
import plugin from '../../../lib/plugins/plugin.js'
import Config from '../lib/config.js'
import { renderHelp, toSegment } from '../lib/render/picmodle.js'
import { checkReadiness } from '../lib/render/assets.js'
import pkg from '../package.json' with { type: 'json' }
const { version } = pkg

const H = () => Config.getUserCfg('config', 'cmdhead')

export class MaiBase extends plugin {
  constructor() {
    super({
      name: 'mai-base',
      dsc: '舞萌DX 帮助',
      event: 'message',
      priority: 100,
      rule: [
        // 裸 #mai / #mai help / #mai 帮助 / #mai 菜单
        { reg: `^[#/]${H()}(\\s+(help|帮助|菜单|maihelp|mai\\s*help))?\\s*$`, fnc: 'help' },
      ],
    })
  }

  async help(e) {
    const ready = checkReadiness()
    if (!ready.ready) {
      await this.reply(
        `未检测到静态资源包（当前曲绘 ${ready.count} 张），无法渲染图片。\n` +
          '请阅读插件 README「安装与资源」：复制 NoneBot 资源包或下载资源包解压到 plugins/mai-plugin/resources/static/ 后重启。'
      )
      return true
    }
    const cmdHead = Config.getUserCfg('config', 'cmdhead')
    const result = await renderHelp(cmdHead, `v${version}`)
    await this.reply(toSegment(result))
    return true
  }
}
