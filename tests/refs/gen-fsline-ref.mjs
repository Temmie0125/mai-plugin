/**
 * 分数线样板对照值生成
 *
 * ⚠️ **样板 markup 里的数字不是规格**：实测它与自己的物量对不上
 * （按脚本公式 TAP GREAT 应为 -0.01140%，markup 却标着 -0.01450%，是上一次渲染的残留）。
 * 故这里**真的把样板跑一遍**、抓它四张表算出的文本，作为 lib/fsline.js 的对照基准。
 *
 * 产物 `tests/refs/fsline_ref.json` 已入库，运行时**不需要**样板文件。
 *
 * 运行（样板路径可用 FSLINE_TPL 覆盖）：
 *   cd E:/bot/Yunzai && node plugins/mai-plugin/tests/refs/gen-fsline-ref.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.join(__dirname, 'fsline_ref.json')

const TPL = process.env.FSLINE_TPL
  || 'E:/User/Download/mai单曲分数线成图/mai单曲分数线成图/分数线成图(prism_plus).html'

/** 待测物量组合（含边界：touch=0、break=0、极小谱面） */
const CASES = [
  { tap: 838, hold: 12, slide: 191, touch: 0, break: 64 },
  { tap: 500, hold: 100, slide: 50, touch: 30, break: 20 },
  { tap: 1000, hold: 0, slide: 0, touch: 0, break: 0 }, // break=0 ⇒ TOTAL_EX_S=0（除零守卫）
  { tap: 1, hold: 1, slide: 1, touch: 1, break: 1 },   // 极小谱面
  { tap: 2000, hold: 200, slide: 300, touch: 100, break: 100 },
  { tap: 0, hold: 0, slide: 0, touch: 0, break: 10 },  // 只有 BREAK
]

/** 把某个 .xxx-count 的括号数值替换掉（样板 markup 里是 `<span class="txt">(838)</span>`） */
function setCount(html, cls, value) {
  const re = new RegExp(`(<div class="cell cell-white ${cls}"><span class="txt">\\()\\d+(\\)</span>)`)
  if (!re.test(html)) throw new Error(`样板里找不到 ${cls} 的计数节点，模板可能已改版`)
  return html.replace(re, `$1${value}$2`)
}

async function main() {
  if (!fs.existsSync(TPL)) {
    console.error(`[gen-fsline-ref] 找不到样板：${TPL}\n  可用 FSLINE_TPL 指定路径。`)
    process.exit(1)
  }
  const puppeteer = (await import('puppeteer')).default
  const base = fs.readFileSync(TPL, 'utf8')
  // 临时副本必须放在样板**同目录**：它的素材都是相对路径（mai/、Resources/）
  const tmpFile = path.join(path.dirname(TPL), `.__fsline_ref_tmp__.html`)

  const browser = await puppeteer.launch({ headless: true })
  const page = await browser.newPage()
  const refs = []

  try {
    for (const c of CASES) {
      let html = base
      html = setCount(html, 'total-count', c.tap + c.hold + c.slide + c.touch + c.break)
      html = setCount(html, 'tap-count', c.tap)
      html = setCount(html, 'hold-count', c.hold)
      html = setCount(html, 'slide-count', c.slide)
      html = setCount(html, 'touch-count', c.touch)
      html = setCount(html, 'break-count', c.break)
      fs.writeFileSync(tmpFile, html, 'utf8')

      await page.goto(pathToFileURL(tmpFile).href, { waitUntil: 'load' })

      const got = await page.evaluate(() => {
        const txt = (sel, root = document) => [...root.querySelectorAll(sel)].map(e => e.textContent.trim())
        return {
          score: txt('.score-grid .cell'),
          brk: txt('.break-region .sub'),
          dx: txt('.rank-grid .cell'),
          rating: txt('.rank2-grid .cell'),
          equiv: txt('.rank3-grid .cell'),
        }
      })
      refs.push({ counts: c, expect: got })
      console.log(`[gen-fsline-ref] ${JSON.stringify(c)} → 分数线首格 ${got.score[5] ?? '?'}`)
    }
  } finally {
    await browser.close()
    fs.rmSync(tmpFile, { force: true })
  }

  fs.writeFileSync(OUT, `${JSON.stringify({ template: path.basename(TPL), cases: refs }, null, 2)}\n`, 'utf8')
  console.log(`[gen-fsline-ref] 已写出 ${OUT}（${refs.length} 组物量）`)
}

main()
