/**
 * Markdown 渲染工具 — 复用 marked + DOMPurify
 * 用于 ClaudeTerminal 的 text 事件渲染
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'

// 配置 marked：GFM、换行视为 <br>、单行 code 不需要语言
marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false
})

/**
 * 把 markdown 字符串转换为安全 HTML
 * @param {string} src
 * @returns {string} HTML 字符串
 */
export function renderMarkdown(src) {
  if (src == null) return ''
  const text = String(src)
  if (!text.trim()) return ''
  try {
    const html = marked.parse(text, { async: false })
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true }
    })
  } catch {
    // 渲染失败兜底为转义文本
    return escapeHtml(text)
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
