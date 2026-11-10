import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MAC_BUNDLE_ID } from '../src/platform.js'
import { run } from './pack-common.mjs'

/** 固定证书用 SHA-1 指纹选取，避免两台 CI runner 上同名证书误选到不同私钥。 */
export function macSigningIdentity(env = process.env) {
  const identity = (env.DSH_MAC_SIGNING_IDENTITY || '').trim()
  if (identity && !/^[0-9a-f]{40}$/i.test(identity)) {
    throw new Error('DSH_MAC_SIGNING_IDENTITY 必须是 40 位证书 SHA-1 指纹')
  }
  if (!identity && env.DSH_MAC_REQUIRE_SIGNED === '1') {
    throw new Error('正式 macOS 包缺少固定签名证书（DSH_MAC_SIGNING_IDENTITY）')
  }
  return identity.toUpperCase() || '-'
}

/**
 * Electron 包里要单独签的代码：Frameworks 下的每个 .framework 与 Helper .app。
 * codesign 的 --deep 不保证由内向外的顺序，所以逐个列出来；先框架后 Helper（Helper 链接框架）。
 */
export function nestedCode(bundle) {
  let names = []
  const frameworks = join(bundle, 'Contents', 'Frameworks')
  try {
    names = readdirSync(frameworks)
  } catch {
    return []
  }
  return [...names.filter((name) => name.endsWith('.framework')), ...names.filter((name) => name.endsWith('.app'))]
    .map((name) => join(frameworks, name))
}

export function signMacBundle(bundle, env = process.env) {
  const identity = macSigningIdentity(env)
  const keychain = (env.DSH_MAC_KEYCHAIN || '').trim()
  const keychainArgs = keychain ? ['--keychain', keychain] : []
  const node = join(bundle, 'Contents', 'Resources', 'app', 'node', 'node')

  // Node 在 Resources/app 下，--deep 签名不会可靠地发现它；先签子代码，再封装外层 app。
  // 同一张证书跨版本、跨架构重用，系统才能用签名要求认出更新后的应用。
  run('codesign', ['--force', '--sign', identity, '--identifier', `${MAC_BUNDLE_ID}.node`, ...keychainArgs, node])
  for (const code of nestedCode(bundle)) {
    // 裁剪 Electron 运行时会改动 framework 内部文件（原有签名随之失效），里面的
    // Helpers（如 chrome_crashpad_handler）不是独立 bundle，得 --deep 一起重签
    run('codesign', ['--force', '--deep', '--sign', identity, ...keychainArgs, code])
  }
  run('codesign', ['--force', '--sign', identity, '--identifier', MAC_BUNDLE_ID, ...keychainArgs, bundle])
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle])
  console.log(identity === '-' ? 'macOS: ad-hoc 签名（仅供本地测试）' : `macOS: 固定证书签名 ${identity}`)
}
