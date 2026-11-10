/** desktop entry 的 Exec 参数里，这些字符可以不加引号；其它一律走引号形式。 */
const EXEC_PLAIN = /^[A-Za-z0-9_\-./:=]+$/

/** desktop entry 值里的控制字符必须转义，否则一行配置会被拆成多行。 */
export function escapeDesktopValue(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
}

/**
 * Exec 字段的一个参数。带空格或元字符时按 Desktop Entry Specification 加引号；
 * 反斜杠、引号、美元和反引号即使在引号里也有转义规则，不能省。
 */
export function desktopExecArg(value) {
  const text = String(value)
  if (/[\r\n]/.test(text)) throw new Error('desktop entry Exec argument cannot contain line breaks')
  if (EXEC_PLAIN.test(text)) return text
  return `"${text
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`')}"`
}

/** Linux 菜单项和 XDG autostart 共用的 desktop entry，保证两处元数据一致。 */
export function desktopEntry({ exec, name = 'DSH-X', icon = 'dsh-x', comment = 'DeepSeek Harness desktop launcher' } = {}) {
  const args = Array.isArray(exec) ? exec : [exec]
  if (!args.length) throw new Error('desktop entry requires an Exec argument')
  return [
    '[Desktop Entry]',
    'Type=Application',
    // Debian 12 的 desktop-file-utils 仍不识别 1.5；1.0 是所有现存桌面都接受的版本。
    'Version=1.0',
    `Name=${escapeDesktopValue(name)}`,
    'Name[zh_CN]=DSH-X',
    `Comment=${escapeDesktopValue(comment)}`,
    `Exec=${args.map(desktopExecArg).join(' ')}`,
    `Icon=${escapeDesktopValue(icon)}`,
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=DSH-X',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n')
}
