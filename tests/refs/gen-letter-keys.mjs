/**
 * 开字母判定表生成（汉字→拼音首字母）
 *
 * 产物 `resources/info/letterKeys.json` **已入库**，运行时**不需要** pinyin-pro ——
 * 本插件坚持「无额外依赖，开箱即用」，故只在开发期借别的插件装好的 pinyin-pro 生成一次。
 *
 * 为什么只需 652 项：曲名里出现的汉字是有限集（实测 1394 首曲共用到 652 个不同汉字）。
 * 日后曲库新增汉字不会让开字母报错，只是那些字开不出来（降级为「只能整题猜」），
 * 需要时重跑本脚本即可。
 *
 * 运行（pinyin-pro 由 phi-plugin 提供，用 PINYIN_PRO_DIR 指定其它位置）：
 *   cd E:/bot/Yunzai && node plugins/mai-plugin/tests/refs/gen-letter-keys.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..')
const LIB = path.join(PLUGIN_ROOT, 'data', 'music', 'merge_music_data.json')
const STATIC_LIB = path.join(PLUGIN_ROOT, 'resources', 'static', 'data', 'merge_music_data.json')
const OUT = path.join(PLUGIN_ROOT, 'resources', 'info', 'letterKeys.json')

const KANA_MODULE = path.join(__dirname, 'kanaInitials.mjs')

/** pinyin-pro 所在目录（默认借宿主机上 phi-plugin 装好的那份） */
const PINYIN_DIR = process.env.PINYIN_PRO_DIR
  || path.resolve(PLUGIN_ROOT, '..', 'phi-plugin', 'node_modules', 'pinyin-pro')

function loadPinyin() {
  try {
    // createRequire 以该目录为基准解析，故不必把 pinyin-pro 装到本插件
    const require = createRequire(path.join(PINYIN_DIR, 'noop.js'))
    return require('pinyin-pro').pinyin
  } catch (error) {
    console.error(
      `[gen-letter-keys] 无法加载 pinyin-pro（尝试目录：${PINYIN_DIR}）\n`
      + `  可用 PINYIN_PRO_DIR=<pinyin-pro 目录> 指定其它位置。\n  原始错误：${error.message}`,
    )
    process.exit(1)
  }
}

const CJK = /[\u4E00-\u9FFF]/

async function main() {
  const pinyin = loadPinyin()
  const { kanaInitials, expandKatakana } = await import(pathToFileURL(KANA_MODULE).href)

  const libPath = fs.existsSync(LIB) ? LIB : STATIC_LIB
  if (!fs.existsSync(libPath)) {
    console.error(`[gen-letter-keys] 找不到曲库：${LIB} 或 ${STATIC_LIB}`)
    process.exit(1)
  }
  const songs = JSON.parse(fs.readFileSync(libPath, 'utf8'))

  const chars = new Set()
  for (const s of songs) {
    for (const ch of String(s.song_name ?? '')) if (CJK.test(ch)) chars.add(ch)
  }

  const hanzi = {}
  for (const ch of [...chars].sort()) {
    const initial = pinyin(ch, { pattern: 'first', toneType: 'none', type: 'string' })
    const lower = String(initial).toLowerCase()
    // 只收单个拉丁字母的结果；多音字/异常返回（如整字回显）一律丢弃，让该字走字面匹配
    if (/^[a-z]$/.test(lower)) hanzi[ch] = lower
  }

  const kana = { ...kanaInitials(), ...expandKatakana(kanaInitials()) }

  const payload = {
    _note: '开字母判定表（汉字→拼音首字母、假名→罗马字首字母）。由 tests/refs/gen-letter-keys.mjs 开发期生成，'
      + '运行时零依赖；表外字符只会「开不出来」，不会报错。',
    hanzi,
    kana,
  }
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 0)}\n`, 'utf8')
  console.log(`[gen-letter-keys] 曲库 ${songs.length} 首 · 汉字 ${Object.keys(hanzi).length} 项 · 假名 ${Object.keys(kana).length} 项`)
  console.log(`[gen-letter-keys] 已写出 ${OUT}`)
}

main()
