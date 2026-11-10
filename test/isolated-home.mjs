import { join } from 'node:path'

/** APP_DIR 在导入业务模块时确定；macOS / Linux 不看 APPDATA，测试必须同时隔离 HOME 和配置文件位置。 */
export function isolateUserHome(root, appData = root) {
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.APPDATA = appData
  if (process.platform === 'darwin') return join(root, 'Library', 'Application Support', 'DSH')
  if (process.platform === 'linux') {
    // 测试必须强制隔离：runner 上可能已经有 XDG_CONFIG_HOME，不能沿用它
    const config = join(root, '.config')
    process.env.XDG_CONFIG_HOME = config
    return join(config, 'DSH')
  }
  return join(appData, 'DSH')
}
