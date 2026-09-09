/** 插件路径单点：plugins/mai-plugin 根目录（lib/path.js → 上两级） */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 插件根目录绝对路径 */
export const pluginRoot = path.resolve(__dirname, '../')

/** 宿主（TRSS-Yunzai）根目录绝对路径 = plugins/mai-plugin 上两级 */
export const yunzaiRoot = path.resolve(pluginRoot, '../../')

/** 插件静态资源根（ADR-8：素材根固定 resources/static/，gitignored） */
export const staticRoot = path.join(pluginRoot, 'resources', 'static')

/** 插件 HTML 模板目录 */
export const htmlRoot = path.join(pluginRoot, 'resources', 'html')
