# macOS Electron shell: two old bugs to recheck

The macOS shell has moved from the old Rust + WKWebView shell to Electron (`shell/`), so internal tabs now run in Chromium. The two bugs below were reported against the old shell. Please recheck them on the new shell, then close or keep tracking them.

## 1. Arrow keys in an empty composer insert junk characters

- **Symptom:** in an internal DSH tab, pressing the arrow keys while the composer is empty inserts invisible control characters such as `\u001c\u001c\u001d\u001d\u001d`.
- **Likely cause:** how WKWebView handles NSEvent arrow keys (`NSUpArrowFunctionKey` and so on). `\x1c`–`\x1f` are exactly the ASCII control codes for left / right / up / down, so the keys appear to be inserted as text instead of being treated as editing commands.
- **First result on the new shell:** sending ↑ ↑ ↓ ← → to an empty `<textarea>` in a tab over the DevTools protocol left the value empty. This used a mock page, **not the real dsh composer**.
- **Please recheck:** start a real dsh instance with the open mode set to "DSH-X internal tabs", then press the arrow keys in an empty composer: single presses, holding a key down, and with an input method active.

## 2. Internal tabs crash at random

- **Symptom:** an internal tab randomly goes black or white, and reloading returns 401.
- **Known cause on the old shell:** the WebKit web content process crashing (JavaScriptCore JIT SIGSEGV / EXC_BREAKPOINT in the logs, often in event callbacks triggered by typing). Commit `7eb8294` added re-authentication and reload after a crash, but didn't stop the crashes.
- **How the new shell handles it:** when a tab fires `render-process-gone`, the shell navigates back to the start-token URL (`recover` in `shell/tabs.mjs`, the same authentication path as the old shell).
- **First result on the new shell:** forcing the tab's renderer to crash with `Page.crash` brought the tab back automatically (the mock server received a second request). The shell process also ran for about 20 hours with no crash logged.
- **Please recheck:** use a real dsh for a long session (several tabs, frequent switching, long typed conversations) and see whether it still crashes. If it does, attach the crash report from `~/Library/Application Support/DSH/electron/Crashpad` and `manager.log`.

## Limitations

- All of the above was checked from source (`npm run electron`) and with a locally ad-hoc-signed `.app`, not with a notarised release build.
- Windows now uses the same Electron shell (`shell/main.mjs`), so the WebView2-only symptoms no longer apply there either; internal tabs are Chromium on both platforms.
