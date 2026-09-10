/**
 * 锅巴（Guoba-Plugin）配置面板支持（设计 §9.2，照 phi-plugin 范式）
 * 约定（Guoba IPluginService/PluginController 实测）：
 * - 必须具名导出 supportGuoba()，返回 { pluginInfo, configInfo }
 * - 配置页入口判定：configInfo.schemas.length >= 3 且 configInfo.getConfigData 为函数
 * - 读写均从 configInfo 上取 getConfigData/setConfigData
 * - schemas 与 config/default_config/config.yaml key 一一对应
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Config from './lib/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function supportGuoba() {
  return {
    pluginInfo: {
      name: 'mai-plugin',
      title: 'mai-plugin',
      author: '@Temmie0125',
      authorLink: 'https://github.com/Temmie0125',
      link: 'https://github.com/Temmie0125/mai-plugin',
      isV3: true,
      isV2: false,
      description: '舞萌DX 查询插件（移植自 nonebot-plugin-maimaidx）',
      iconPath: path.join(__dirname, 'resources', 'icons', 'plugin_icon.png'),
      iconColor: '#e91e8c',
    },
    configInfo: {
      schemas: [
        { label: '命令与基础', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'cmdhead',
          label: '命令头',
          bottomHelpMessage: '触发「#mai …」的词，可改为 maimai/maidx 等，修改后需重启生效',
          component: 'Input',
          required: true,
        },
        {
          field: 'botName',
          label: 'BOT名称',
          bottomHelpMessage: '授权链接等文案中使用，留空取宿主昵称',
          component: 'Input',
        },
        {
          field: 'aliasPush',
          label: '别名推送',
          bottomHelpMessage: 'SSE/WS 新别名推送总开关',
          component: 'Switch',
        },
        {
          field: 'aliasProxy',
          label: '柚子cn镜像',
          bottomHelpMessage: '别名服务器走 cn 镜像（网络不佳时开启）',
          component: 'Switch',
        },
        { label: '素材与渲染', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'saveInMemory',
          label: '素材内存化',
          bottomHelpMessage: '启动预载官方切图，加快渲染，占用更多内存',
          component: 'Switch',
        },
        {
          field: 'assetsOnline',
          label: '在线素材回退',
          bottomHelpMessage: '本地缺失的曲绘/切图尝试从在线源获取',
          component: 'Switch',
        },
        {
          field: 'autoUpdateAssets',
          label: '自动更新资源',
          bottomHelpMessage: '开启后执行「插件更新」时自动检查并更新静态资源包',
          component: 'Switch',
        },
        {
          field: 'assetsRepo',
          label: '资源仓库地址',
          bottomHelpMessage: '静态资源包的 git 地址；国内直连 GitHub 不畅时可填代理前缀地址，'
            + '如 https://gh-proxy.com/https://github.com/Temmie0125/mai-plugin-resource-static.git',
          component: 'Input',
        },
        {
          field: 'renderQuality',
          label: '截图质量',
          bottomHelpMessage: '截图 jpeg 质量',
          component: 'InputNumber',
          componentProps: { min: 1, max: 100, addonAfter: '%' },
        },
        {
          field: 'renderTimeout',
          label: '截图超时',
          bottomHelpMessage: '超时后放弃本次截图，单位 ms',
          component: 'InputNumber',
          componentProps: { min: 5000, max: 120000, addonAfter: 'ms' },
        },
        { label: '水鱼查分器（Diving-Fish）', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'proberProxy',
          label: '水鱼代理',
          bottomHelpMessage: '使用代理服务器访问水鱼查分器 API',
          component: 'Switch',
        },
        {
          field: 'dfClientId',
          label: '水鱼 OAuth ClientID',
          bottomHelpMessage: '与 ClientSecret 同时配置后「绑定水鱼」才可用',
          component: 'Input',
          componentProps: {
            placeholder: '请输入ClientID',
            type: 'password'
          }
        },
        {
          field: 'dfClientSecret',
          label: '水鱼 OAuth ClientSecret',
          component: 'Input',
          componentProps: {
            placeholder: '请输入ClientSecret',
            type: 'password'
          }
        },
        {
          field: 'dfAuthUrl',
          label: '水鱼授权地址',
          component: 'Input',
          bottomHelpMessage: '默认 https://auth.diving-fish.com',
        },
        { label: '落雪查分器（LXNS）', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'lxnsDevToken',
          label: '落雪开发者Token',
          bottomHelpMessage: '使用落雪数据源查分必需',
          component: 'Input',
          componentProps: {
            placeholder: '请输入开发者Token',
            type: 'password'
          }
        },
        {
          field: 'lxClientId',
          label: '落雪 OAuth ClientID',
          bottomHelpMessage: '与 Secret/回调地址同时配置后「绑定落雪」才可用',
          component: 'Input',
          componentProps: {
            placeholder: '请输入ClientID',
            type: 'password'
          }
        },
        {
          field: 'lxClientSecret',
          label: '落雪 OAuth ClientSecret',
          component: 'Input',
          componentProps: {
            placeholder: '请输入ClientSecret',
            type: 'password'
          }
        },
        {
          field: 'lxRedirectUri',
          label: '落雪 OAuth 回调地址',
          component: 'Input',
        },
        {
          field: 'lxnsBindPrivateOnly',
          label: '落雪绑定仅私聊',
          component: 'Switch',
        },
        { label: '列表', component: 'SOFT_GROUP_BEGIN' },
        {
          field: 'helpMaxRows',
          label: '列表单页行数',
          component: 'InputNumber',
          componentProps: { min: 10, max: 200 },
        },
        {
          field: 'pageSize',
          label: '分页大小',
          bottomHelpMessage: '多候选选曲、投票列表等分页大小',
          component: 'InputNumber',
          componentProps: { min: 5, max: 50 },
        },
      ],
      // 读取/写回当前配置（键与 yaml 一一对应）
      getConfigData() {
        return Config.getUserCfg('config')
      },
      async setConfigData(data) {
        for (const [key, value] of Object.entries(data)) {
          if (value === undefined || value === null) continue
          Config.modify('config', key, value)
        }
        return true
      },
    },
  }
}
