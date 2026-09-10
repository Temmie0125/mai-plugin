/**
 * 模板静态资源存在性不变量
 *
 * 模板里**字面量**引用的 `{{_staticPath}}/…`（底图 / @font-face 字体 / 图标）必须在静态包里
 * 真实存在：file:// 下这类引用 404 不会让渲染报错——图片悄悄消失、@font-face 悄悄回退系统
 * 字体（微软雅黑），只有目检出图才能发现。fsline 首版把样板的 fonts/ 文件夹移植成静态根、
 * 丢了 /font/ 段，四张表全部回退雅黑即是此因，故立此不变量。
 * 视图运行时拼接的动态 src（{{coverSrc}}、picSrc() 等）不在此范围。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const htmlDir = path.join(__dirname, '..', 'resources', 'html')
const staticRoot = path.join(__dirname, '..', 'resources', 'static')

test('模板字面量 {{_staticPath}} 引用的资源全部存在（防悄悄 404 / 字体回退）', () => {
  const templates = fs.readdirSync(htmlDir).filter(f => f.endsWith('.html'))
  assert.ok(templates.length > 0, 'resources/html 下未找到模板')

  let totalRefs = 0
  for (const file of templates) {
    const html = fs.readFileSync(path.join(htmlDir, file), 'utf8')
    // 引用出现在 src="…" / CSS url(…) 两种形态，取到引号/右括号/空白为止；%20 等按解码后路径核对
    const refs = [...html.matchAll(/\{\{_staticPath\}\}\/([^'"\)\s]+)/g)]
      .map(m => m[1]).map(decodeURIComponent)
    totalRefs += refs.length
    for (const ref of refs) {
      assert.ok(
        fs.existsSync(path.join(staticRoot, ref)),
        `${file} 引用的静态资源不存在：${ref}`,
      )
    }
  }
  assert.ok(totalRefs >= 10, '字面量引用总数异常偏少，匹配正则可能已失配')
})
