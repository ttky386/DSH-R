/**
 * 官方市场的索引是 volatile 配置，写 Profile 或追加 --patch 会覆盖用户在「发现」页的选择。
 * 因此只替换 schema 缺省值：显式 indexes（包括 []）仍按官方原有规则处理。
 * 锚点不匹配就跳过；既不修改安装文件，也不自动启用实验性市场。
 */
export function pluginMarketDefaultsPatch(source, value) {
  let indexes
  try { indexes = JSON.parse(value || '[]') } catch { return null }
  if (!Array.isArray(indexes) || !indexes.length || !indexes.every((url) => typeof url === 'string')) return null
  const anchor = String.raw`indexes: z.array(z.string().pattern(/^https?:\/\/\S+$/u)).default([]).volatile()`
  if (!source.includes(anchor)) return null
  return source.replace(anchor, () => anchor.replace('.default([])', () => `.default(${JSON.stringify(indexes)})`))
}

export function load(url, context, nextLoad) {
  const result = nextLoad(url, context)
  if (!url.includes('/dsh-plugin-market/lib/index.js') || result.format !== 'module' || result.source === undefined) return result
  const source = Buffer.isBuffer(result.source) ? result.source.toString('utf8') : String(result.source)
  const patched = pluginMarketDefaultsPatch(source, process.env.DSH_X_PLUGIN_MARKET_SOURCES)
  return patched === null ? result : { ...result, source: patched }
}
