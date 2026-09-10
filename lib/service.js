/**
 * 曲库服务单例（源 core/service/__init__.py MaiMusic 直译 + 设计 §6.1 三链路加载）
 * 迁移自 nonebot-plugin-maimaidx（Yuri-YuzuChaN）。
 * 加载顺序：① data/music/ 缓存 → ② resources/static/data/ 一次性导入 → ③ 联网拉取合并重建。
 * 动静分离：static/ 全程只读，运行时产物只写 data/music/。
 * 猜歌状态机（源 Guess/GroupAlias）P3 接入。
 */
import fs from 'node:fs'
import path from 'node:path'
import Config from './config.js'
import { pluginRoot, staticRoot } from './path.js'
import { MusicList } from './merge/musicList.js'
import { AliasList } from './merge/aliasList.js'
import { Alias } from './merge/models.js'
import { mergeAliasData, mergeMusicData } from './merge/merge.js'
import { DivingFishAPI } from './client/divingfish.js'
import { LxnsAPI } from './client/lxns.js'
import { YuzuChaNAPI } from './client/yuzuchan.js'
import { readJson, writeJsonAtomic } from './jsonFile.js'

const logger = global.logger || console

/** 曲库缓存目录（`setDataRoot` 可注入，生产恒为插件根下 data/music） */
export let musicDataDir = path.join(pluginRoot, 'data', 'music')
/** 本地别名文件（同上） */
export let localAliasFile = path.join(pluginRoot, 'data', 'alias', 'local_music_alias.json')

/**
 * 测试注入数据目录（生产勿用；与 `lib/database.js:setDataRoot` 同款）
 * 别名写路径与离线重建会落盘，测试必须改到临时目录，否则会写真机 `data/`。
 */
export function setDataRoot(dir) {
  musicDataDir = path.join(dir, 'music')
  localAliasFile = path.join(dir, 'alias', 'local_music_alias.json')
}

/** data/music/ 内缓存的文件名（与源 static/data key 契约一致） */
export const MUSIC_CACHE_FILES = [
  'music_data.json', 'music_chart.json', 'lxns_music_data.json', 'lxns_music_alias.json',
  'merge_music_data.json', 'merge_music_alias.json', 'music_alias.json', 'plate_data.json',
]

/** 曲库缓存写入口：原子写（见 lib/jsonFile.js），indent 4 与源 writefile 一致 */
function writeJson(file, data) {
  writeJsonAtomic(file, data, { indent: 4 })
}

class MaiMusic {
  constructor() {
    /** @type {MusicList} */
    this.totalList = new MusicList()
    /** @type {AliasList} */
    this.totalAliasList = new AliasList()
    this.totalPlateIdList = {}
    this.totalLevelData = {}
    /** song_id-level_index → 定数，如 {"11451-3": 13.5} */
    this.totalLevelValueMap = {}
    this.ready = false
    /** 进行中的初始化 Promise（防并发重复拉取） */
    this._initing = null
  }

  /**
   * 启动加载（三链路，index.js 顶层调用；失败后首条命令触发 lazy 重试）
   * @param {{network?: boolean}} opts network=true 允许联网重建（首启无缓存时）
   */
  async init({ network = true } = {}) {
    if (this.ready) return true
    if (this._initing) return await this._initing
    this._initing = this._load(network)
    try {
      return await this._initing
    } finally {
      this._initing = null
    }
  }

  async _load(network) {
    const musicFile = path.join(musicDataDir, 'merge_music_data.json')
    const aliasFile = path.join(musicDataDir, 'merge_music_alias.json')
    const plateFile = path.join(musicDataDir, 'plate_data.json')

    // ① 运行时缓存
    if (fs.existsSync(musicFile) && fs.existsSync(aliasFile) && fs.existsSync(plateFile)) {
      this._applyLoaded(readJson(musicFile, []), readJson(aliasFile, []), readJson(plateFile, {}))
      logger.mark(`[mai-plugin] 曲库缓存载入完成：${this.totalList.root.length} 曲 · 别名 ${this.totalAliasList.root.length} 条`)
      this.ready = true
      return true
    }

    // ② 静态资源包内旧 NoneBot 缓存一次性导入（此后 static 侧不再读取）
    const staticDataDir = path.join(staticRoot, 'data')
    const staticMusic = path.join(staticDataDir, 'merge_music_data.json')
    if (fs.existsSync(staticMusic)) {
      fs.mkdirSync(musicDataDir, { recursive: true })
      for (const file of MUSIC_CACHE_FILES) {
        const src = path.join(staticDataDir, file)
        if (fs.existsSync(src) && !fs.existsSync(path.join(musicDataDir, file))) {
          fs.copyFileSync(src, path.join(musicDataDir, file))
        }
      }
      if (fs.existsSync(path.join(musicDataDir, 'merge_music_alias.json'))
        && fs.existsSync(path.join(musicDataDir, 'plate_data.json'))) {
        this._applyLoaded(
          readJson(path.join(musicDataDir, 'merge_music_data.json'), []),
          readJson(path.join(musicDataDir, 'merge_music_alias.json'), []),
          readJson(path.join(musicDataDir, 'plate_data.json'), {})
        )
        logger.mark(`[mai-plugin] 已导入静态资源包曲库缓存：${this.totalList.root.length} 曲`)
        this.ready = true
        return true
      }
    }

    // ③ 联网重建
    if (!network) return false
    try {
      await this.update()
      this.ready = true
      return true
    } catch (error) {
      logger.error('[mai-plugin] 曲库联网初始化失败：', error?.message || error)
      return false
    }
  }

  _applyLoaded(musicData, aliasData, plateData) {
    this.totalList = MusicList.fromJSON(musicData)
    // 定数映射从合并列表重建（DF map 的超集，utage/新曲亦有 key）
    this.totalLevelValueMap = {}
    for (const song of this.totalList.root) {
      for (const diff of song.difficulties) {
        this.totalLevelValueMap[`${song.song_id}-${diff.level_index}`] = diff.level_value
      }
    }
    this.totalLevelData = this.totalList.byLevelList()
    this.totalAliasList = AliasList.fromJSON(aliasData)
    this.totalPlateIdList = plateData ?? {}
  }

  /** 拉取并合并曲目数据（源 get_music：DF music_data+chart_stats、LXNS song/list） */
  async getMusic() {
    const api = new DivingFishAPI()
    let musicData
    let chartStats
    try {
      musicData = await api.musicData()
      writeJson(path.join(musicDataDir, 'music_data.json'), musicData)
    } catch (error) {
      logger.error(`[mai-plugin] maimaiDX曲库数据获取失败（${error.message}），尝试本地暂存`)
      musicData = readJson(path.join(musicDataDir, 'music_data.json'))
      if (musicData == null) throw error
    }
    try {
      chartStats = await api.chartStats()
      writeJson(path.join(musicDataDir, 'music_chart.json'), chartStats)
    } catch (error) {
      logger.error(`[mai-plugin] maimaiDX谱面数据获取失败（${error.message}），尝试本地暂存`)
      chartStats = readJson(path.join(musicDataDir, 'music_chart.json'))
      if (chartStats == null) throw error
    }
    logger.mark('[mai-plugin] 成功获取「水鱼」查分器曲目数据')

    let lxnsData = null
    if (Config.getUserCfg('config', 'lxnsDevToken')) {
      try {
        lxnsData = await new LxnsAPI().musicData()
        writeJson(path.join(musicDataDir, 'lxns_music_data.json'), lxnsData)
        logger.mark('[mai-plugin] 成功获取「落雪」查分器曲目数据')
      } catch (error) {
        logger.warn(`[mai-plugin] 落雪曲目数据获取失败，跳过该数据源：${error.message}`)
      }
    } else {
      logger.warn('[mai-plugin] 未配置落雪开发者Token（lxnsDevToken），跳过获取「落雪」曲目数据源')
    }

    logger.mark('[mai-plugin] 正在合并曲目数据…')
    const { list, levelValueMap } = mergeMusicData({
      divingFishList: musicData,
      lxnsList: lxnsData,
      statsMap: chartStats?.charts ?? {},
    })
    this.totalList = list
    this.totalLevelValueMap = { ...levelValueMap }
    for (const song of list.root) {
      for (const diff of song.difficulties) {
        this.totalLevelValueMap[`${song.song_id}-${diff.level_index}`] = diff.level_value
      }
    }
    this.totalLevelData = list.byLevelList()
    writeJson(path.join(musicDataDir, 'merge_music_data.json'), list.root)
    logger.mark('[mai-plugin] 曲目数据合并完成')
  }

  /** 拉取并合并别名（源 get_music_alias：柚子 + LXNS + 本地） */
  async getMusicAlias() {
    let yuzuData
    try {
      yuzuData = await new YuzuChaNAPI().getAliases()
      writeJson(path.join(musicDataDir, 'music_alias.json'), yuzuData)
      logger.mark('[mai-plugin] 成功获取「柚子」别名数据')
    } catch (error) {
      logger.error(`[mai-plugin] 获取所有曲目别名信息错误（${error.message}），尝试本地暂存`)
      yuzuData = readJson(path.join(musicDataDir, 'music_alias.json'))
      if (!yuzuData) throw error
    }

    let lxnsAliases = null
    if (Config.getUserCfg('config', 'lxnsDevToken')) {
      try {
        lxnsAliases = await new LxnsAPI().musicAliasData()
        writeJson(path.join(musicDataDir, 'lxns_music_alias.json'), lxnsAliases)
        logger.mark('[mai-plugin] 成功获取「落雪」别名数据')
      } catch (error) {
        logger.warn(`[mai-plugin] 落雪别名数据获取失败，跳过：${error.message}`)
      }
    }

    const localAliasData = readJson(localAliasFile)

    logger.mark('[mai-plugin] 正在合并别名数据…')
    this.totalAliasList = mergeAliasData({ yuzuAliases: yuzuData, lxnsAliases, localAliasData })
    writeJson(path.join(musicDataDir, 'merge_music_alias.json'), this.totalAliasList.root)
    logger.mark('[mai-plugin] 别名数据合并完成')
  }

  /** 拉取牌子数据（源 get_plate_json） */
  async getPlateJson() {
    let plateData
    try {
      plateData = await new YuzuChaNAPI().getPlateJson()
      writeJson(path.join(musicDataDir, 'plate_data.json'), plateData)
    } catch (error) {
      logger.error(`[mai-plugin] 获取牌子数据错误（${error.message}），尝试本地暂存`)
      plateData = readJson(path.join(musicDataDir, 'plate_data.json'))
      if (!plateData) throw error
    }
    this.totalPlateIdList = plateData
    logger.mark('[mai-plugin] 成功获取牌子数据')
  }

  /** 全量更新（`#mai sync` 与每日 04:00 task 共用） */
  async update() {
    await this.getMusic()
    await this.getMusicAlias()
    await this.getPlateJson()
    this.ready = true
    logger.mark('[mai-plugin] maimaiDX数据更新完毕')
  }
}

export const mai = new MaiMusic()

/**
 * 添加本地别名（源 `core/service/__init__.py:295-327` `update_local_alias` 直译）
 * - 别名**存小写**（源 `alias_name.lower()`），键为 songId 的字符串形式
 * - 先改内存 `totalAliasList`（有该曲的行则 append，无则新建一行）再落盘，与源同序
 * - 落盘文件 `data/alias/local_music_alias.json`（`writeJsonAtomic` 会自动建目录）
 *
 * 与源同：写入**不**重建 `merge_music_alias.json`（源要等下次「更新别名库」或重启才生效）——
 * 「加完即生效」由调用方随后调 `rebuildAliasFromCache()` 实现。
 *
 * 纯磁盘 I/O，故为同步函数（源是 async 只因 aiofiles）。
 * @returns {boolean} 失败返回 false（调用方回「添加本地别名失败」）
 */
export function updateLocalAlias(songId, aliasName) {
  try {
    const key = String(songId)
    const alias = String(aliasName).toLowerCase()

    const localAliasData = readJson(localAliasFile, {}) ?? {}
    if (!Array.isArray(localAliasData[key])) localAliasData[key] = []
    if (!localAliasData[key].includes(alias)) localAliasData[key].push(alias)

    const entries = mai.totalAliasList.byId(songId)
    if (entries.length) {
      if (!entries[0].alias.includes(alias)) entries[0].alias.push(alias)
    } else {
      const song = mai.totalList.byId(songId)
      mai.totalAliasList.root.push(Alias({
        song_id: songId,
        song_name: song ? song.song_name : '',
        alias: [alias],
      }))
    }

    writeJson(localAliasFile, localAliasData)
    return true
  } catch (error) {
    logger.error(`[mai-plugin] 添加本地别名失败: ${error?.message || error}`)
    return false
  }
}

/**
 * 只读缓存重建别名库（**源没有这一步，是端口补的缺口**）
 *
 * 源的 `update_local_alias` 写完只改内存，要到下次「更新别名库」或重启才落进
 * `merge_music_alias.json`；而本插件的 `getMusicAlias()` 开头就联网拉柚子，没法离线重建。
 * 本函数只读 `data/music/` 里的既有原始数据（`music_alias.json` / `lxns_music_alias.json`）
 * 加本地别名文件，重跑合并 —— 于是 `alias local` 能做到**加完即生效**。
 *
 * 纯磁盘 I/O，故为同步函数。
 * @returns {boolean} 缓存缺失或合并结果为空（首次安装尚未同步过）时返回 false，由调用方联网兜底
 */
export function rebuildAliasFromCache() {
  const yuzuAliases = readJson(path.join(musicDataDir, 'music_alias.json'))
  if (!Array.isArray(yuzuAliases)) return false
  const lxnsAliases = readJson(path.join(musicDataDir, 'lxns_music_alias.json'))
  const localAliasData = readJson(localAliasFile)

  const merged = mergeAliasData({ yuzuAliases, lxnsAliases, localAliasData })
  if (!merged.root.length) return false
  mai.totalAliasList = merged
  writeJson(path.join(musicDataDir, 'merge_music_alias.json'), merged.root)
  return true
}

/**
 * 命令入口惰性校验（设计 §10.1 兜底：启动拉取失败后首条命令触发重试一次）
 * @returns {Promise<boolean>} 未就绪时已向 e 回复引导文案
 */
export async function ensureReady(e = null) {
  if (mai.ready) return true
  const ok = await mai.init()
  if (ok) return true
  e?.reply?.('曲库尚未就绪（首次联网拉取失败）。请稍后重试，或联系 BOT 管理员执行数据同步。')
  return false
}
