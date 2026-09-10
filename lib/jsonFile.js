/**
 * JSON 读写单点（P3 实施文档 §3.4-1，ADR 崩溃安全加固）
 *
 * 为什么必须原子写：同步过程（`#mai sync` / 每日 task）边拉边落盘，而宿主更新器
 * （`plugins/other/update.js`）可能在任何时刻重启进程——若是 `writeFileSync` 直写，
 * 被砍在写一半就留下截断的 JSON。而 `lib/service.js` 的 `_load()` 三链路会把它当缓存读进来
 * （`merge_music_data.json` 截断解析成 `[]` ⇒ 曲库空、就绪检测误报、所有查询静默失败）。
 *
 * 源侧 `core/tool.py:writefile` 用的是 aiofiles 直写（截断式），本模块是对源的刻意改进。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 读 JSON；文件缺失 / 空白 / 解析失败一律回退 fallback（语义由调用方决定）
 * @param {string} file
 * @param {any} [fallback]
 */
export function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return raw.trim() ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

/**
 * 原子写：先写 `<file>.tmp` 再 `renameSync` 覆盖目标。
 * 同卷 rename 在 Windows 上可覆盖已存在文件，是原子替换；中断只会留下 .tmp，目标文件始终完整。
 * @param {string} file
 * @param {any} data
 * @param {{indent?: number}} [opts]
 */
export function writeJsonAtomic(file, data, { indent = 2 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent))
  fs.renameSync(tmp, file)
}
