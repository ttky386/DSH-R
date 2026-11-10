# DSH-R

DSH-R is a secondary-development project based on the [DSH-X launcher](https://github.com/yyh-001/DSH-X). It extends DSH-X from a primarily local manager into a desktop controller that can also manage remote Linux DSH instances safely.

It is not the official DSH-X line maintained by the original author, and it is neither [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) nor an official DeepSeek product. Both upstream projects use the MIT License; this branch keeps the same license and attribution.

## Secondary-development statement

- Original project: **DSH-X** — <https://github.com/yyh-001/DSH-X>
- DSH upstream: **DeepSeek Harness** — <https://github.com/deepseek-ai/deepseek-harness>
- Current baseline: DSH-X `v0.1.26-rc.4`
- Relationship: DSH-R extends DSH-X with remote-management features. It does not replace the official DSH-X repository or impersonate an upstream release channel.
- DSH-R still launches DSH's original web interface. This project handles installation, launching, configuration and management; it does not rewrite DSH's chat UI.

## Features

### Capabilities inherited from DSH-X

- Launch entries and multiple local instances
- DSH version installation, updates, removal and rollback
- Profile and DSH home management
- Plugin, pack, MCP and skill management
- Desktop-enhancement plugins: native notifications, context menu and sidebar browser
- Local logs, recovery, self-update and cross-platform desktop shell

### DSH-R extensions

- **Remote Linux management**: the Windows controller manages remote Linux DSH through OpenSSH keys or ssh-agent; SSH passwords are never stored.
- **Run DSH itself remotely**: the remote host does not install DSH-X and does not expose a DSH-X API. Operations invoke a restricted remote agent over SSH.
- **Remote version management**: install, remove, replace and optimize remote DSH versions, with local launch references kept in sync.
- **Remote profile management**: manage remote profiles, configuration, dependencies, plugins, packs, MCP, skills, recovery data and logs.
- **Remote file workflow**: reuse DSH's official `file-upload`, `workspace-files`, `sidebar-files`, `documentpreview` and `file-reference` plugins. Files dropped into a conversation stream directly to the remote host, while DSH-R can browse and preview files under the remote `DSH_HOME`.
- **Remote shell**: a full PTY terminal with interactive commands, session retention and terminal resizing.
- **Remote access adaptation**: remote DSH stays on loopback while a remote reverse-forward listener accepts VPN / LAN connections and adapts request headers for some loopback-only plugins.
- **Remote page integration**: remote DSH pages open in DSH-X internal tabs and share the same tray, instance state and access-link UI.
- **Linux desktop support**: Linux AppImage / deb packaging, XDG directories, desktop integration and file-manager adaptation.
- **Windows installer hardening**: safer exit handling, repair of broken old installations, offline core replacement and a unified installation location.

## Boundaries

- The controller primarily targets Windows; remote targets support Linux x64 / arm64.
- Remote connections require a usable SSH key, ssh-agent or OpenSSH configuration. SSH passwords are neither stored nor auto-filled.
- Remote desktop notifications, clipboard and file-dialog plugin APIs are not bridged to Windows yet.
- The remote file panel is read-only browsing with bounded preview. It does not write, delete, rename or expose arbitrary paths, and sensitive credential files are rejected.
- Drag-and-drop upload, the file tree, right-sidebar preview and path clicks depend on official DSH plugins.
- reverse-forward handles HTTP / WebSocket only; it is not a general TCP proxy.
- The project is named DSH-R, while package names, process names and installer display strings still use DSH-X / DSH. A full brand rename has not been done.
