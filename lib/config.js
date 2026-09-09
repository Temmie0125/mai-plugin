/**
 * mai-plugin 配置模块（yaml 双轨：default_config 出厂默认 / config 用户副本）
 * 范式参考 phi-plugin Config.js：首启复制缺失 yaml，读取时用户值优先，缺失回退默认并补写。
 */
import YAML from 'yaml'
import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot } from './path.js'

const Plugin_Name = 'mai-plugin'
const Plugin_Path = pluginRoot

class Config {
  constructor() {
    /** @type {Record<string, any>} */
    this.config = {}
    /** @type {Record<string, any>} */
    this.watcher = {}
    this.initCfg()
  }

  /** 初始化配置：把 default_config 下缺失的 yaml 复制到 config/ 用户目录 */
  initCfg() {
    const pathDef = `${Plugin_Path}/config/default_config/`
    const pathUser = `${Plugin_Path}/config/config/`
    if (!fs.existsSync(pathUser)) fs.mkdirSync(pathUser, { recursive: true })
    const files = fs.readdirSync(pathDef).filter(file => file.endsWith('.yaml'))
    for (const file of files) {
      if (!fs.existsSync(`${pathUser}${file}`)) {
        fs.copyFileSync(`${pathDef}${file}`, `${pathUser}${file}`)
      }
    }
  }

  /** 出厂默认配置 */
  getdefSet(name) {
    return YAML.parse(fs.readFileSync(`${Plugin_Path}/config/default_config/${name}.yaml`, 'utf8'))
  }

  /** 用户配置 */
  getConfig(name) {
    if (this.config[name]) return this.config[name]
    const file = `${Plugin_Path}/config/config/${name}.yaml`
    this.config[name] = YAML.parse(fs.readFileSync(file, 'utf8')) || {}
    return this.config[name]
  }

  /**
   * 用户值优先，缺失回退默认
   * @param {'config'|'banGroup'} name 文件名
   * @param {string} [key] key 值；不传返回整个合并配置
   */
  getUserCfg(name, key = undefined) {
    let def = this.getdefSet(name)
    let config = this.getConfig(name)
    // 数组型配置（如 banGroup）：整体替换，不做对象展开合并
    if (Array.isArray(def)) {
      if (key) return undefined
      return Array.isArray(config) && config.length ? config : def
    }
    const merged = { ...def, ...config }
    if (key) return merged[key]
    return merged
  }

  /**
   * 修改用户配置
   * @param {string} name 文件名
   * @param {string} key key 值
   * @param {any} value 值
   */
  modify(name, key, value) {
    const file = `${Plugin_Path}/config/config/${name}.yaml`
    const config = this.getConfig(name)
    config[key] = value
    fs.writeFileSync(file, YAML.stringify(config))
    delete this.config[name]
  }
}

const configInstance = new Config()

export default configInstance

/**
 * 命令头词（cmdhead），用于 rule 正则构造期插值（ADR-6）
 * 正则内使用需转义，防止用户配置特殊字符
 */
export function head() {
  const raw = configInstance.getUserCfg('config', 'cmdhead') || 'mai'
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
