import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 核心自己的版本号。
 *
 * package.json 留在仓库根（版本、devDependencies 都在那），不复制进 src/；
 * 打包时 pack-common 会把它抄到核心根。所以运行时先看核心目录，再看源码布局
 * （src/ 的上一级）。两种布局都认，静态 `import './package.json'` 在源码运行时会炸。
 */
const ROOT = dirname(fileURLToPath(import.meta.url))

function readPackage() {
  const candidates = [join(ROOT, 'package.json'), join(ROOT, '..', 'package.json')]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // 清单坏了不该连服务都起不来，版本号退回 0.0.0
    }
  }
  return {}
}

export const CORE_VERSION = String(readPackage().version || '0.0.0')
