/**
 * DSH-X Sidebar Browser：Client 半边。
 *
 * 跑在 dsh 页面里，长轮询 Host 的命令，在官方右侧栏 Browser tab 的 Electron
 * <webview> 里执行 snapshot/click/type/screenshot 等。Host 不直接碰 DOM。
 *
 * 结构参考 dsh-sidebar-browser（MIT，Copyright (c) 2026 The dsh-sidebar-browser
 * authors）；本实现用当前屏幕上的 Session id 轮询，只执行属于该 Session 的命令。
 */

window.__ModuleLoader__.load({
  id: 'dsh-x-sidebar-browser',
  factory(require) {
    const POLL_WAIT_MS = 25000
    const FRAME_SELECTOR = 'webview[data-sidebar-browser-frame]'
    const LIST_LIMIT = 120
    const VIEWPORT_STORAGE_KEY = 'dsh-x-sidebar-browser:viewport'
    const VIEWPORT_ZOOMS = ['fit', 50, 75, 100, 125, 150, 200]
    const VIEWPORT_STYLE_ID = 'dsh-x-sidebar-browser:viewport-style'

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /** Reject a guest promise that never settles (a wedged Browser frame). */
    function withTimeout(promise, ms, message) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
      ])
    }

    function safe(read) {
      try {
        return read()
      } catch {
        return undefined
      }
    }

    //#region Guest page helpers — stringified and evaluated inside the Browser frame.
    function pageSnapshot(options) {
      const maxRefs = Number(options.maxRefs) > 0 ? Number(options.maxRefs) : 80
      const maxTextChars = Number(options.maxTextChars) > 0 ? Number(options.maxTextChars) : 12000
      const selector = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'textarea',
        'select',
        'summary',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[role="switch"]',
        '[contenteditable="true"]',
      ].join(',')
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return false
        const style = getComputedStyle(element)
        return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0
      }
      const labelOf = (element) => {
        const raw = element.getAttribute('aria-label')
          || element.getAttribute('title')
          || element.getAttribute('placeholder')
          || element.getAttribute('alt')
          || element.innerText
          || element.value
          || element.getAttribute('name')
          || ''
        return String(raw).replace(/\s+/g, ' ').trim().slice(0, 160)
      }
      const refs = []
      let refsTruncated = false
      const candidates = document.querySelectorAll(selector)
      for (const element of candidates) {
        if (refs.length >= maxRefs) {
          refsTruncated = true
          break
        }
        if (!isVisible(element) || element.disabled === true) continue
        const ref = refs.length + 1
        element.setAttribute('data-dsh-x-sb-ref', String(ref))
        const tag = element.tagName.toLowerCase()
        const entry = { ref, tag }
        const role = element.getAttribute('role')
        if (role !== null) entry.role = role
        const type = element.getAttribute('type')
        if (type !== null) entry.type = type
        const label = labelOf(element)
        if (label.length > 0) entry.label = label
        if (tag === 'a') {
          const href = element.getAttribute('href')
          if (href !== null) entry.href = String(href).slice(0, 500)
          if (label.length === 0) {
            const image = element.querySelector('img[alt]')
            const alt = image === null ? '' : String(image.getAttribute('alt') || '').replace(/\s+/g, ' ').trim()
            if (alt.length === 0) continue
            entry.label = alt.slice(0, 160)
          }
        }
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          if (element.value !== undefined && element.value !== '') entry.value = String(element.value).slice(0, 300)
          if (element.type === 'checkbox' || element.type === 'radio') entry.checked = element.checked === true
          if (tag === 'select') {
            entry.options = Array.from(element.options).slice(0, 40).map((option) => ({
              value: option.value,
              label: String(option.label || option.text || '').slice(0, 120),
              selected: option.selected === true,
            }))
          }
        }
        refs.push(entry)
      }
      const rawText = document.body === null ? '' : String(document.body.innerText || '')
      const text = rawText.replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim()
      return {
        url: String(location.href),
        title: String(document.title || ''),
        readyState: String(document.readyState),
        scroll: {
          x: Math.round(window.scrollX),
          y: Math.round(window.scrollY),
          height: document.documentElement === null ? 0 : document.documentElement.scrollHeight,
        },
        refs,
        refsTruncated,
        text: text.slice(0, maxTextChars),
        textTruncated: text.length > maxTextChars,
      }
    }

    function pageFind(options) {
      if (options.ref !== undefined && options.ref !== null) {
        return document.querySelector('[data-dsh-x-sb-ref="' + String(options.ref) + '"]')
      }
      if (typeof options.selector === 'string' && options.selector.length > 0) {
        return document.querySelector(options.selector)
      }
      return null
    }

    function pageClick(options) {
      const element = pageFind(options)
      if (element === null) {
        throw new Error(options.ref !== undefined
          ? 'No element has ref ' + String(options.ref) + ' on this page; take a new snapshot.'
          : 'No element matches selector ' + String(options.selector) + '.')
      }
      const label = String(element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const target = element.closest('a,button,label,summary,[role="button"],[role="link"]') || element
      target.click()
      return { clicked: { tag: target.tagName.toLowerCase(), label }, url: String(location.href) }
    }

    function pageType(options) {
      const element = pageFind(options)
      if (element === null) {
        throw new Error(options.ref !== undefined
          ? 'No element has ref ' + String(options.ref) + ' on this page; take a new snapshot.'
          : 'No element matches selector ' + String(options.selector) + '.')
      }
      const text = String(options.text)
      element.scrollIntoView({ block: 'center' })
      if (typeof element.focus === 'function') element.focus()
      if (element.isContentEditable === true) {
        element.textContent = text
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
      } else {
        const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')
        if (setter !== undefined && typeof setter.set === 'function') setter.set.call(element, text)
        else element.value = text
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (options.submit === true) {
        if (element.form !== null && element.form !== undefined && typeof element.form.requestSubmit === 'function') element.form.requestSubmit()
        else element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
      }
      return { typed: text.length, target: element.tagName.toLowerCase(), url: String(location.href) }
    }

    function pagePress(options) {
      const key = String(options.key)
      const target = document.activeElement || document.body
      const keyCode = key === 'Enter' ? 13
        : key === 'Tab' ? 9
          : key === 'Escape' ? 27
            : key === 'ArrowDown' ? 40
              : key === 'ArrowUp' ? 38
                : key === 'ArrowLeft' ? 37
                  : key === 'ArrowRight' ? 39
                    : key === ' ' || key === 'Space' ? 32
                      : 0
      const init = { key, code: key === ' ' ? 'Space' : key, keyCode, which: keyCode, bubbles: true, cancelable: true }
      target.dispatchEvent(new KeyboardEvent('keydown', init))
      target.dispatchEvent(new KeyboardEvent('keyup', init))
      if (key === 'Enter' && target.form !== null && target.form !== undefined && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        try {
          target.form.requestSubmit()
        } catch {
          // A form without a submitter still keeps the dispatched key event.
        }
      }
      return { pressed: key, active: target === null ? 'body' : target.tagName.toLowerCase() }
    }

    function pageSelect(options) {
      const element = pageFind(options)
      if (element === null) throw new Error('No select element matches the given ref or selector.')
      if (element.tagName !== 'SELECT') throw new Error('The target element is <' + element.tagName.toLowerCase() + '>, not a <select>.')
      const value = String(options.value)
      element.value = value
      if (element.value !== value) {
        const option = Array.from(element.options).find((candidate) => candidate.text === value || candidate.label === value)
        if (option !== undefined) element.value = option.value
      }
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { value: element.value, selectedIndex: element.selectedIndex }
    }

    function pageScroll(options) {
      if (options.ref !== undefined && options.ref !== null) {
        const element = pageFind(options)
        if (element === null) throw new Error('No element has ref ' + String(options.ref) + '; take a new snapshot.')
        element.scrollIntoView({ block: 'center' })
        return { scrolledTo: { ref: options.ref }, y: Math.round(window.scrollY) }
      }
      const amount = Number(options.amount) > 0 ? Number(options.amount) : 600
      const direction = String(options.direction || 'down')
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const dy = direction === 'up' ? -amount : amount
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' })
      return { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }
    }

    async function pageWait(options) {
      const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (typeof options.selector === 'string' && options.selector.length > 0) {
          if (document.querySelector(options.selector) !== null) return { found: true, kind: 'selector', selector: options.selector }
        } else if (typeof options.text === 'string' && options.text.length > 0) {
          const bodyText = document.body === null ? '' : String(document.body.innerText || '')
          if (bodyText.includes(options.text)) return { found: true, kind: 'text', text: options.text }
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      throw new Error('Timed out after ' + String(timeoutMs) + 'ms waiting for '
        + (typeof options.selector === 'string' && options.selector.length > 0 ? 'selector ' + options.selector : 'text ' + String(options.text)) + '.')
    }
    //#endregion

    function frameIsVisible(element) {
      try {
        if (document.visibilityState === 'hidden') return false
        if (element.isConnected !== true) return false
        if (element.closest('[hidden], [aria-hidden="true"], [inert]') !== null) return false
        if (element.getClientRects().length === 0) return false
        const rect = element.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return false
        // A collapsed right Sidebar translates its content off the frame instead of
        // hiding it; a rect with a size but no on-screen intersection is not visible
        // and capturePage would hang on it.
        if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) return false
        const style = window.getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
      } catch {
        return false
      }
    }

    function browserFrames() {
      return Array.from(document.querySelectorAll(FRAME_SELECTOR))
    }

    function activeBrowserTab(ctx) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.active !== 'function') return undefined
      const tab = safe(() => sidebarRight.active())
      if (tab === undefined || tab === null || tab.kind !== 'browser') return undefined
      return tab
    }

    function frameForTab(tab) {
      if (tab === undefined || tab === null || tab.id === undefined || tab.id === null) return undefined
      const escape = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(String(tab.id)) : String(tab.id)
      return document.querySelector('div[data-sidebar-right-tab="' + escape + '"] ' + FRAME_SELECTOR)
        || undefined
    }

    function pickFrame(state, ctx) {
      const tab = activeBrowserTab(ctx)
      if (tab !== undefined) {
        const exact = frameForTab(tab)
        if (exact !== undefined) return exact
      }
      const frames = browserFrames()
      if (frames.length === 0) return undefined
      const visibleFrames = frames.filter(frameIsVisible)
      if (state.last !== undefined && state.last.isConnected === true && visibleFrames.includes(state.last)) return state.last
      if (visibleFrames.length > 0) return visibleFrames[visibleFrames.length - 1]
      if (state.last !== undefined && state.last.isConnected === true) return state.last
      return frames[frames.length - 1]
    }

    async function frameReady(frame, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      let lastError
      while (Date.now() < deadline) {
        try {
          if (frame.isConnected === false) throw new Error('the Browser tab was closed')
          const ping = await withTimeout(frame.executeJavaScript('1', true), 2500, 'The Browser frame did not respond.')
          if (ping === 1) return true
        } catch (error) {
          lastError = error
        }
        await sleep(150)
      }
      throw new Error('The Browser frame is not ready'
        + (lastError instanceof Error && lastError.message ? ': ' + lastError.message : '. Open or reload the Browser tab and retry.'))
    }

    function sidebarRightOf(ctx) {
      if (typeof ctx.get === 'function') return ctx.get('sidebarRight')
      return ctx.sidebarRight
    }

    /** The Session currently on screen; the Browser tab is per-Session. */
    function currentSession(ctx) {
      const sidebarRight = sidebarRightOf(ctx)
      return String(safe(() => sidebarRight?.mounted?.getSnapshot()) ?? '')
    }

    async function openBrowserTab(ctx, url) {
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null) {
        throw new Error('The right Sidebar is unavailable in this Harness page, so a Browser tab cannot be opened (Desktop app required for Browser control).')
      }
      try {
        sidebarRight.openTab('browser', { params: { url } })
      } catch (error) {
        throw new Error('Could not open the right-Sidebar Browser: ' + (error instanceof Error ? error.message : String(error)))
      }
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const tab = activeBrowserTab(ctx)
        const frame = (tab === undefined ? undefined : frameForTab(tab))
          || browserFrames().filter(frameIsVisible)[0]
          || browserFrames()[0]
        if (frame !== undefined) return frame
        await sleep(150)
      }
      throw new Error('The Browser tab was requested but no Browser frame appeared. Check that the right Sidebar Browser is enabled in this Harness build.')
    }

    async function settleActiveFrame(state, ctx, fallback) {
      let frame = pickFrame(state, ctx) || fallback
      if (frame === undefined) return undefined
      await frameReady(frame, 15000)
      await waitForHttpPage(frame, 30000)
      const latest = pickFrame(state, ctx)
      if (latest !== undefined && latest !== frame) {
        // The dock re-created the tab body while loading (new occurrence/lease).
        frame = latest
        await frameReady(frame, 15000)
        await waitForHttpPage(frame, 30000)
      }
      state.last = frame
      return frame
    }

    async function activeFrame(state, ctx, options) {
      let frame = pickFrame(state, ctx)
      if (frame === undefined && options.openUrl !== undefined) frame = await openBrowserTab(ctx, options.openUrl)
      if (frame === undefined) {
        throw new Error('No Browser tab is open in the right Sidebar. Call the browser tool with action "open" and a url first.')
      }
      await frameReady(frame, options.readyTimeoutMs === undefined ? 15000 : options.readyTimeoutMs)
      state.last = frame
      return frame
    }

    function tabIdOfFrame(frame) {
      const holder = frame.closest('div[data-sidebar-right-tab]')
      if (holder === null) return undefined
      return holder.getAttribute('data-sidebar-right-tab') || undefined
    }

    function frameTabInfo(ctx, frame) {
      const tabId = tabIdOfFrame(frame)
      const holder = frame.closest('[data-sidebar-right-session]')
      const frameSession = holder === null ? undefined : holder.getAttribute('data-sidebar-right-session') || undefined
      const fallback = { same: true, tabId, browserTab: undefined, current: undefined, frameSession }
      const sidebarRight = sidebarRightOf(ctx)
      if (sidebarRight === undefined || sidebarRight === null) return fallback
      const mounted = safe(() => sidebarRight.mounted?.getSnapshot())
      const current = safe(() => sidebarRight.focusedTarget?.())
      const tabs = safe(() => sidebarRight.openTabs?.getSnapshot())
      const currentSession = (current === undefined || current === null ? undefined : current.sessionId) ?? mounted
      const same = currentSession === undefined || frameSession === undefined ? true : frameSession === currentSession
      let browserTab
      if (Array.isArray(tabs)) {
        const candidates = tabs.filter((tab) => tab.kind === 'browser' && tab.tabId === tabId)
        browserTab = candidates.find((tab) => tab.sessionId === currentSession) || candidates[candidates.length - 1]
      }
      return { same, tabId, browserTab, current, frameSession }
    }

    /** Bring the frame into the visible, expanded right Sidebar so capturePage is not blank. */
    async function revealFrame(ctx, frame) {
      if (frameIsVisible(frame)) return
      const sidebarRight = sidebarRightOf(ctx)
      const info = frameTabInfo(ctx, frame)
      if (!info.same) {
        throw new Error('The Browser page belongs to another Session than the one on screen, so it cannot be shown or captured here. '
          + 'Bring that Session on screen, or call action "open" to open the page in the current Session.')
      }
      const tabId = info.tabId
      if (sidebarRight !== undefined && sidebarRight !== null && tabId !== undefined && typeof sidebarRight.focus === 'function') {
        try {
          sidebarRight.focus(tabId)
        } catch {
          // Focus is best-effort; expansion below still runs.
        }
        const deadline = Date.now() + 2000
        while (Date.now() < deadline && !frameIsVisible(frame)) await sleep(100)
      }
      if (frameIsVisible(frame)) return
      if (sidebarRight !== undefined && sidebarRight !== null
        && safe(() => sidebarRight.isExpanded()) !== true
        && typeof sidebarRight.toggleExpanded === 'function') {
        try {
          sidebarRight.toggleExpanded()
        } catch (error) {
          throw new Error('The Browser tab is hidden and the right Sidebar could not be expanded: '
            + (error instanceof Error ? error.message : String(error)))
        }
        const deadline = Date.now() + 3000
        while (Date.now() < deadline && !frameIsVisible(frame)) await sleep(100)
      }
      if (!frameIsVisible(frame)) {
        const active = safe(() => sidebarRight?.active())
        throw new Error('The Browser tab is hidden (collapsed, inert, or another tab is in front), so a screenshot would be blank.'
          + (active === undefined ? '' : ' Active right-Sidebar tab: ' + String(active.kind) + ' ' + String(active.id) + '.')
          + ' Open the Browser panel visibly, then retry.')
      }
    }

    /**
     * Make a frame capturable. A frame that is not on screen is revealed in place;
     * when that fails we do NOT reopen the page in a new tab (that loses the modal
     * or form state the operator is looking at and can take longer than the tool
     * timeout). The Host gets the guest WebContents id instead and captures it
     * directly.
     */
    async function ensureScreenshotFrame(state, ctx, frame) {
      await revealFrame(ctx, frame)
      return frame
    }

    function runPage(frame, fn, args) {
      const code = '(async () => { try {'
        + ' const pageFind = ' + pageFind.toString() + ';'
        + ' const value = await (' + fn.toString() + ')(' + JSON.stringify(args === undefined ? {} : args) + ');'
        + ' return value === undefined ? null : value;'
        + ' } catch (error) { return { __dshError: error && error.message ? String(error.message) : String(error) } } })()'
      return withTimeout(frame.executeJavaScript(code, true), 20000, 'The Browser page did not answer the command in time.')
        .then((value) => {
          if (value !== null && typeof value === 'object' && typeof value.__dshError === 'string') {
            throw new Error(value.__dshError)
          }
          return value
        })
    }

    async function waitForHttpPage(frame, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const url = safe(() => frame.getURL())
        if (typeof url === 'string' && /^https?:/i.test(url) && safe(() => frame.isLoading()) !== true) {
          const state = await safe(() => frame.executeJavaScript('document.readyState', true))
          if (state === 'complete' || state === 'interactive') return url
        }
        await sleep(150)
      }
      return safe(() => frame.getURL())
    }

    async function isLoading(frame) {
      try {
        return frame.isLoading() === true
      } catch {
        return false
      }
    }

    function sendKey(frame, key) {
      try {
        frame.focus()
        frame.sendInputEvent({ type: 'keyDown', keyCode: key })
        if (key.length === 1) frame.sendInputEvent({ type: 'char', keyCode: key })
        frame.sendInputEvent({ type: 'keyUp', keyCode: key })
        return 'native'
      } catch {
        return 'dom'
      }
    }

    async function settle(frame, quietMs, waitStartMs) {
      const start = Date.now()
      await sleep(quietMs)
      const startWindow = waitStartMs === undefined ? 1500 : waitStartMs
      let sawLoading = await isLoading(frame)
      while (Date.now() - start < 15000) {
        const loading = await isLoading(frame)
        if (loading) sawLoading = true
        else if (sawLoading || Date.now() - start > quietMs + startWindow) break
        await sleep(120)
      }
      await sleep(150)
    }

    async function navigateTo(frame, url) {
      try {
        await withTimeout(frame.loadURL(url), 20000, 'Navigation did not start in time.')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/ERR_ABORTED/.test(message)) throw new Error('Navigation to ' + url + ' failed: ' + message)
      }
      await settle(frame, 150)
      await frameReady(frame, 10000)
    }

    function formatSnapshot(snapshot) {
      const lines = []
      lines.push('url: ' + snapshot.url)
      lines.push('title: ' + (snapshot.title.length > 0 ? snapshot.title : '(untitled)'))
      lines.push('scroll: y=' + String(snapshot.scroll.y) + ' pageHeight=' + String(snapshot.scroll.height))
      lines.push('refs: ' + String(snapshot.refs.length) + (snapshot.refsTruncated ? ' (truncated; refine with eval or selector)' : ''))
      for (const ref of snapshot.refs) {
        const details = []
        if (ref.role !== undefined && ref.role !== '') details.push('role=' + ref.role)
        if (ref.type !== undefined && ref.type !== '') details.push('type=' + ref.type)
        if (ref.value !== undefined && ref.value !== '') details.push('value=' + JSON.stringify(ref.value))
        if (ref.checked !== undefined) details.push('checked=' + String(ref.checked))
        if (ref.label !== undefined && ref.label !== '') details.push(JSON.stringify(ref.label))
        if (ref.href !== undefined) details.push('-> ' + ref.href)
        if (ref.options !== undefined) {
          const shown = ref.options.slice(0, 8).map((option) => option.value + (option.selected ? '*' : ''))
          details.push('options[' + String(ref.options.length) + ']=' + shown.join('|') + (ref.options.length > 8 ? '|...' : ''))
        }
        lines.push('#' + String(ref.ref) + ' <' + ref.tag + '> ' + details.join(' '))
      }
      if (snapshot.refs.length === 0) lines.push('(no visible interactive elements)')
      lines.push('')
      lines.push('text:')
      lines.push(snapshot.text.length > 0 ? snapshot.text : '(empty page text)')
      if (snapshot.textTruncated) lines.push('(text truncated; use eval to read a specific region)')
      return lines.join('\n')
    }

    function statusText(ctx) {
      const frames = browserFrames()
      const sidebarRight = sidebarRightOf(ctx)
      const lines = []
      lines.push('platform: ' + (globalThis.dshDesktop === undefined ? 'web' : 'desktop'))
      lines.push('session: ' + (currentSession(ctx).length > 0 ? currentSession(ctx) : '(none on screen)'))
      lines.push('browserFrames: ' + String(frames.length))
      let activeTab
      if (sidebarRight !== undefined && sidebarRight !== null && typeof sidebarRight.active === 'function') {
        const tab = safe(() => sidebarRight.active())
        if (tab !== undefined && tab !== null) {
          activeTab = { id: tab.id, kind: tab.kind, title: tab.title }
          lines.push('activeTab: ' + JSON.stringify(activeTab))
          lines.push('rightbarExpanded: ' + String(safe(() => sidebarRight.isExpanded()) === true))
        }
      }
      frames.forEach((frame, index) => {
        const info = frameTabInfo(ctx, frame)
        lines.push('frame[' + String(index) + '] visible=' + String(frameIsVisible(frame))
          + ' url=' + String(safe(() => frame.getURL()) || '(unknown)')
          + ' title=' + JSON.stringify(String(safe(() => frame.getTitle()) || ''))
          + ' loading=' + String(safe(() => frame.isLoading()) === true)
          + (info.same ? '' : ' (Session ' + String(info.frameSession) + ' is not the one on screen)'))
      })
      if (frames.length === 0) lines.push('No Browser frame is mounted. Use action "open" with a url to create the tab.')
      return lines.join('\n')
    }

    async function capture(frame, timeoutMs = 8000) {
      if (typeof frame.capturePage !== 'function') throw new Error('This Harness build does not expose capturePage on the Browser frame.')
      const image = await Promise.race([
        frame.capturePage(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(
          'The Browser frame did not produce a screenshot in time. The page may be occluded, collapsed, or not composited. '
          + 'Expand the Browser tab and bring the DSH-X window to the front, then retry.',
        )), timeoutMs)),
      ])
      if (image === undefined || image === null) throw new Error('The Browser frame returned no screenshot.')
      if (typeof image.isEmpty === 'function' && image.isEmpty()) throw new Error('The Browser frame returned an empty screenshot.')
      const dataUrl = String(image.toDataURL())
      const prefix = 'data:image/png;base64,'
      if (!dataUrl.startsWith(prefix)) throw new Error('The screenshot used an unexpected encoding.')
      const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 }
      return { base64: dataUrl.slice(prefix.length), width: size.width, height: size.height }
    }

    async function executeCommand(state, command) {
      const action = String(command.action)
      const args = command.args !== null && typeof command.args === 'object' ? command.args : {}
      const ctx = state.ctx

      if (action === 'status') return { text: statusText(ctx) }

      if (action === 'open') {
        const url = String(args.url || '')
        let frame = pickFrame(state, ctx)
        let visible = frame !== undefined
        if (frame !== undefined) {
          await frameReady(frame, 15000)
          await navigateTo(frame, url)
          try {
            await revealFrame(ctx, frame)
          } catch {
            visible = false
          }
        }
        if (!visible) {
          await openBrowserTab(ctx, url)
          const settled = await settleActiveFrame(state, ctx, undefined)
          if (settled === undefined) throw new Error('The Browser tab was requested but no Browser frame appeared.')
          frame = settled
        }
        state.last = frame
        return { text: 'Opened ' + url + '\n' + statusText(ctx) }
      }

      // Screenshot must not wait for the guest to answer a JS ping: a wedged or
      // occluded page can leave executeJavaScript pending forever. Pick the frame,
      // try a bounded page-side capture, and otherwise hand the Host the guest id.
      if (action === 'screenshot') {
        const frame = pickFrame(state, ctx)
        if (frame === undefined) {
          throw new Error('No Browser tab is open in the right Sidebar. Call action "open" with a url first.')
        }
        const webContentsId = typeof frame.getWebContentsId === 'function' ? frame.getWebContentsId() : undefined
        let image
        let firstError
        try {
          image = await withTimeout((async () => {
            const target = await ensureScreenshotFrame(state, ctx, frame)
            return await capture(target)
          })(), 15000, 'The page-side screenshot did not finish in 15s (the Browser frame is likely collapsed, occluded, or not composited).')
        } catch (error) {
          firstError = error
        }
        const detail = image === undefined && firstError !== undefined
          ? '\npage capture: ' + (firstError instanceof Error ? firstError.message : String(firstError))
          : ''
        const text = 'Screenshot requested.\n' + statusText(ctx) + detail
        if (image !== undefined) return { text, png: image, webContentsId }
        if (Number.isInteger(webContentsId) && webContentsId > 0) return { text, webContentsId }
        throw firstError instanceof Error ? firstError : new Error('The screenshot could not be captured.')
      }

      const frame = await activeFrame(state, ctx, {})

      switch (action) {
        case 'navigate': {
          const url = String(args.url || '')
          await navigateTo(frame, url)
          return { text: 'Navigated to ' + url + '\n' + statusText(ctx) }
        }
        case 'back': {
          if (safe(() => frame.canGoBack()) !== true) throw new Error('The Browser tab has no back history.')
          safe(() => frame.goBack())
          await settle(frame, 200)
          await frameReady(frame, 10000)
          return { text: 'Went back.\n' + statusText(ctx) }
        }
        case 'forward': {
          if (safe(() => frame.canGoForward()) !== true) throw new Error('The Browser tab has no forward history.')
          safe(() => frame.goForward())
          await settle(frame, 200)
          await frameReady(frame, 10000)
          return { text: 'Went forward.\n' + statusText(ctx) }
        }
        case 'reload': {
          safe(() => frame.reload())
          await settle(frame, 250)
          await frameReady(frame, 15000)
          return { text: 'Reloaded the page.\n' + statusText(ctx) }
        }
        case 'snapshot': {
          const snapshot = await runPage(frame, pageSnapshot, {
            maxRefs: Number(args.max_refs) > 0 ? Math.min(Number(args.max_refs), LIST_LIMIT) : 80,
            maxTextChars: Number(args.max_text_chars) > 0 ? Number(args.max_text_chars) : 12000,
          })
          return { text: formatSnapshot(snapshot) }
        }
        case 'click': {
          const outcome = await runPage(frame, pageClick, { ref: args.ref, selector: args.selector })
          await settle(frame, 350, 4500)
          return {
            text: 'Clicked <' + outcome.clicked.tag + '> ' + JSON.stringify(outcome.clicked.label)
              + '\nurl: ' + String(safe(() => frame.getURL()) || outcome.url)
              + '\ntitle: ' + JSON.stringify(String(safe(() => frame.getTitle()) || ''))
              + '\nTake a new snapshot before the next ref-based action.',
          }
        }
        case 'type': {
          const outcome = await runPage(frame, pageType, { ref: args.ref, selector: args.selector, text: args.text, submit: args.submit === true })
          await settle(frame, 300, 4500)
          return {
            text: 'Typed ' + String(outcome.typed) + ' characters into <' + outcome.target + '>.'
              + (args.submit === true ? ' Submitted the form.' : '')
              + '\nurl: ' + String(safe(() => frame.getURL()) || outcome.url)
              + '\ntitle: ' + JSON.stringify(String(safe(() => frame.getTitle()) || '')),
          }
        }
        case 'press': {
          const key = String(args.key)
          if (sendKey(frame, key) === 'dom') {
            const outcome = await runPage(frame, pagePress, { key })
            await settle(frame, 300, 4500)
            return { text: 'Pressed ' + JSON.stringify(outcome.pressed) + ' on <' + outcome.active + '> (DOM event fallback).' }
          }
          if (key === 'Enter' || key === ' ' || key === 'Space') {
            // Native key events drive page handlers; the DOM pass also submits a
            // focused form when the guest swallowed the native default action.
            try {
              await runPage(frame, pagePress, { key })
            } catch {
              // The guest may already be navigating.
            }
          }
          await settle(frame, 300, 4500)
          return {
            text: 'Pressed ' + JSON.stringify(key) + '.'
              + '\nurl: ' + String(safe(() => frame.getURL()) || '')
              + '\ntitle: ' + JSON.stringify(String(safe(() => frame.getTitle()) || '')),
          }
        }
        case 'select': {
          const outcome = await runPage(frame, pageSelect, { ref: args.ref, selector: args.selector, value: args.value })
          await settle(frame, 250)
          return { text: 'Selected value ' + JSON.stringify(outcome.value) + ' (index ' + String(outcome.selectedIndex) + ').'
            + '\ntitle: ' + JSON.stringify(String(safe(() => frame.getTitle()) || '')) }
        }
        case 'scroll': {
          const outcome = await runPage(frame, pageScroll, {
            ref: args.ref,
            selector: args.selector,
            direction: args.direction,
            amount: args.amount,
          })
          return { text: 'Scrolled to y=' + String(outcome.y === undefined ? '?' : outcome.y) }
        }
        case 'wait': {
          const outcome = await runPage(frame, pageWait, {
            selector: args.selector,
            text: args.text,
            timeoutMs: Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : 5000,
          })
          return { text: 'Appeared: ' + JSON.stringify(outcome) }
        }
        case 'eval': {
          const script = String(args.script)
          const code = '(async () => { const value = (' + script + '); const resolved = await value;'
            + ' try { return JSON.parse(JSON.stringify(resolved === undefined ? null : resolved)) } catch { return String(resolved) } })()'
          const value = await frame.executeJavaScript(code, true)
          const text = JSON.stringify(value, null, 2)
          return { text: text.length > 20000 ? text.slice(0, 20000) + '\n(truncated)' : text }
        }
        case 'close': {
          const sidebarRight = sidebarRightOf(ctx)
          if (sidebarRight === undefined || sidebarRight === null) throw new Error('The right Sidebar is unavailable in this Harness page.')
          const tab = safe(() => sidebarRight.active())
          if (tab !== undefined && tab !== null && tab.kind === 'browser' && tab.id !== undefined && tab.id !== null) {
            sidebarRight.close(tab.id)
            state.last = undefined
            return { text: 'Closed Browser tab ' + String(tab.id) + '.' }
          }
          // The Browser tab may sit behind another tab or in a Session that is no longer
          // on screen; close the tab that owns our frame instead of the visible one.
          const frame = pickFrame(state, ctx)
          const info = frame === undefined ? undefined : frameTabInfo(ctx, frame)
          if (info !== undefined && info.frameSession !== undefined && info.tabId !== undefined
            && typeof sidebarRight.closeIn === 'function') {
            try {
              sidebarRight.closeIn(info.frameSession, info.tabId)
              state.last = undefined
              return { text: 'Closed Browser tab ' + String(info.tabId) + '.' }
            } catch (error) {
              throw new Error('Could not close the Browser tab: ' + (error instanceof Error ? error.message : String(error)))
            }
          }
          if (tab !== undefined && tab !== null) throw new Error('The active right-Sidebar tab is "' + String(tab.kind) + '", not a Browser tab.')
          throw new Error('There is no active right-Sidebar tab to close.')
        }
        default:
          throw new Error('Unsupported browser action ' + JSON.stringify(action) + '.')
      }
    }

    //#region Fixed Browser viewport
    /**
     * The official Browser tab fills the Sidebar and the page reflows with every
     * drag. A fixed 1280x720 (or another preset) viewport scaled to fit keeps the
     * page's own desktop layout stable for the operator and for the agent's refs.
     */
    function readViewport() {
      try {
        const raw = JSON.parse(String(localStorage.getItem(VIEWPORT_STORAGE_KEY) || '{}'))
        const width = Number(raw.width)
        const height = Number(raw.height)
        const zoom = raw.zoom === 'fit' || VIEWPORT_ZOOMS.includes(Number(raw.zoom))
          ? (raw.zoom === 'fit' ? 'fit' : Number(raw.zoom))
          : 'fit'
        if (Number.isFinite(width) && Number.isFinite(height) && width >= 320 && height >= 240 && width <= 4096 && height <= 4096) {
          return { width, height, zoom }
        }
      } catch { /* default */ }
      return { width: 1280, height: 720, zoom: 'fit' }
    }

    function writeViewport(viewport) {
      try { localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(viewport)) } catch { /* private mode */ }
    }

    function ensureViewportStyle() {
      if (document.getElementById(VIEWPORT_STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = VIEWPORT_STYLE_ID
      style.textContent = `
webview[data-dsh-x-fixed-viewport] {
  position: absolute !important;
  left: var(--dsh-x-sb-left, 0px) !important;
  top: var(--dsh-x-sb-top, 0px) !important;
  width: var(--dsh-x-sb-width, 1280px) !important;
  height: var(--dsh-x-sb-height, 720px) !important;
  min-width: var(--dsh-x-sb-width, 1280px) !important;
  min-height: var(--dsh-x-sb-height, 720px) !important;
  max-width: none !important;
  max-height: none !important;
  flex: none !important;
  margin: 0 !important;
  transform: scale(var(--dsh-x-sb-scale, 1)) !important;
  transform-origin: top left !important;
}
.dsh-x-sb-viewport-bar {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(20, 22, 28, .78);
  border: 1px solid rgba(255, 255, 255, .14);
  color: #e5e7eb;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .24);
  backdrop-filter: blur(8px);
  pointer-events: auto;
}
.dsh-x-sb-viewport-bar select,
.dsh-x-sb-viewport-bar input {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 0 2px;
  outline: none;
  cursor: pointer;
}
.dsh-x-sb-viewport-bar input {
  width: 44px;
  text-align: center;
  cursor: text;
}
.dsh-x-sb-viewport-bar input::-webkit-outer-spin-button,
.dsh-x-sb-viewport-bar input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.dsh-x-sb-times { opacity: .55; }
.dsh-x-sb-pick {
  width: 22px;
  height: 22px;
  margin-left: 2px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.dsh-x-sb-pick:hover { background: rgba(255, 255, 255, .12); }
.dsh-x-sb-toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%) translateY(8px);
  z-index: 2147483001;
  padding: 6px 12px;
  border-radius: 8px;
  background: #1b1f2a;
  color: #fff;
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  opacity: 0;
  pointer-events: none;
  transition: opacity .16s ease, transform .16s ease;
}
.dsh-x-sb-toast[data-on="1"] { opacity: 1; transform: translateX(-50%) translateY(0); }
`
      document.head.append(style)
    }

    //#region Element picker → composer
    /**
     * Picker injected into the Browser guest. Adapted from @yechayo/dsh-pick
     * (MIT, Copyright (c) 2026 yechayo): hover highlights, click resolves with
     * the element's selector/tag/HTML/text/rect, Esc cancels.
     */
    const PICKER_SRC = `(function () {
  if (window.__dshXSbPickBusy) return Promise.resolve(null);
  window.__dshXSbPickBusy = true;
  function esc(v) {
    if (window.CSS && CSS.escape) return CSS.escape(String(v));
    return String(v).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\\\' + c; });
  }
  function classes(el) {
    var out = [];
    var list = el.classList || [];
    for (var i = 0; i < list.length && out.length < 2; i++) {
      var c = list[i];
      if (!c) continue;
      if (c.indexOf('__') >= 0) continue;
      if (/[A-Z]/.test(c) && /[0-9]/.test(c) && c.length >= 6) continue;
      out.push(c);
    }
    return out;
  }
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + esc(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      var part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + esc(node.id)); break; }
      var cls = classes(node);
      if (cls.length) part = part + '.' + cls.map(esc).join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = 0, index = 0;
        for (var i = 0; i < parent.children.length; i++) {
          var sib = parent.children[i];
          if (sib.tagName === node.tagName) { same++; if (sib === node) index = same; }
        }
        if (same > 1) part += ':nth-of-type(' + index + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }
  function describe(el) {
    var r = el.getBoundingClientRect();
    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      cls: String(el.getAttribute('class') || '').slice(0, 200),
      html: (el.outerHTML || '').slice(0, 2000),
      text: String(el.innerText || el.textContent || '').trim().slice(0, 300),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      url: location.href,
      title: document.title
    };
  }
  return new Promise(function (resolve) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;border:2px solid #4d6bfe;background:rgba(77,107,254,.14);border-radius:2px;display:none;left:0;top:0;width:0;height:0';
    var tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;background:#1b1f2a;color:#fff;font:12px/1.5 ui-monospace,Consolas,monospace;padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis;left:0;top:0';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(tip);
    var current = null;
    var timer = setTimeout(function () { finish(null); }, 120000);
    function cleanup() {
      window.__dshXSbPickBusy = false;
      clearTimeout(timer);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      if (box.parentNode) box.parentNode.removeChild(box);
      if (tip.parentNode) tip.parentNode.removeChild(tip);
      try { delete window.__dshXSbPickCancel; } catch (e) { window.__dshXSbPickCancel = void 0; }
    }
    function finish(value) { cleanup(); resolve(value); }
    window.__dshXSbPickCancel = function () { finish(null); };
    function onMove(e) {
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === box || el === tip) return;
      current = el;
      var r = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      tip.style.display = 'block';
      tip.textContent = selectorFor(el) + '  ' + Math.round(r.width) + 'x' + Math.round(r.height);
      var top = r.top > 26 ? r.top - 24 : r.bottom + 4;
      tip.style.left = Math.max(2, Math.min(r.left, window.innerWidth - 240)) + 'px';
      tip.style.top = top + 'px';
    }
    function onDown(e) { e.preventDefault(); e.stopPropagation(); }
    function onClick(e) {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      finish(current ? describe(current) : null);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    }
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
  });
})()`

    function composerEditor() {
      return document.querySelector('[data-conversation-region="composer"] [contenteditable="true"]')
        || document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
        || document.querySelector('[contenteditable="true"]')
    }

    function dataUrlToFile(dataUrl, name) {
      const comma = dataUrl.indexOf(',')
      const head = dataUrl.slice(0, comma)
      const body = dataUrl.slice(comma + 1)
      const mime = /:(.*?);/.exec(head)?.[1] || 'image/png'
      const binary = atob(body)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return new File([bytes], name, { type: mime })
    }

    /** Insert a reference chip into the composer's Lexical draft (same shape as @file chips). */
    function insertChip(editor, chip) {
      try {
        if (editor === null || editor === undefined || typeof editor.getEditorState !== 'function') return false
        const state = editor.getEditorState().toJSON()
        const root = state === null || state === undefined ? null : state.root
        if (root === null || !Array.isArray(root.children)) return false
        let paragraph = root.children[root.children.length - 1]
        if (paragraph === undefined || paragraph.type !== 'paragraph') {
          paragraph = { type: 'paragraph', version: 1, direction: null, format: '', indent: 0, children: [] }
          root.children.push(paragraph)
        }
        if (!Array.isArray(paragraph.children)) paragraph.children = []
        paragraph.children.push({
          type: 'reference-chip',
          version: 1,
          source: 'reference',
          ref: chip.ref,
          label: chip.label,
          clipboardText: chip.clipboardText,
        })
        editor.setEditorState(editor.parseEditorState(state))
        return true
      } catch {
        return false
      }
    }

    function elementChip(picked) {
      const tag = String(picked.tag || 'element')
      const firstClass = String(picked.cls || '').split(/\s+/).filter(Boolean)[0]
      const name = firstClass === undefined ? tag : `${tag}.${firstClass}`
      const lines = [`［元素］${name}（selector: ${picked.selector || ''}）`]
      const page = [picked.title, picked.url].filter(Boolean).join(' — ')
      if (page.length > 0) lines.push(`页面：${page}`)
      if (picked.text) lines.push(`文本：${picked.text}`)
      if (picked.html) lines.push(`HTML：${picked.html}`)
      return { label: name, ref: lines.join('\n'), clipboardText: `［元素］${name}` }
    }

    function toast(message) {
      let node = document.getElementById('dsh-x-sb-toast')
      if (node === null) {
        node = document.createElement('div')
        node.id = 'dsh-x-sb-toast'
        node.className = 'dsh-x-sb-toast'
        document.body.appendChild(node)
      }
      node.textContent = message
      node.dataset.on = '1'
      clearTimeout(node.__timer)
      node.__timer = setTimeout(() => { node.dataset.on = '0' }, 2600)
    }

    async function pickElement(parent) {
      const frame = parent.querySelector('webview[data-sidebar-browser-frame]')
      if (frame === null) {
        toast('先打开右侧栏的浏览器')
        return
      }
      let picked
      try {
        picked = await withTimeout(frame.executeJavaScript(PICKER_SRC, true), 125000, '拾取超时')
      } catch (error) {
        toast('拾取失败：' + (error instanceof Error ? error.message : String(error)))
        return
      }
      if (picked === null || picked === undefined) {
        toast('已取消拾取')
        return
      }
      const chip = elementChip(picked)
      let dataUrl
      try {
        const rect = picked.rect
        const crop = {
          x: Math.max(0, Math.floor(rect.x) - 4),
          y: Math.max(0, Math.floor(rect.y) - 4),
          width: Math.max(1, Math.ceil(rect.width) + 8),
          height: Math.max(1, Math.ceil(rect.height) + 8),
        }
        const image = await withTimeout(frame.capturePage(crop), 4000, '元素截图超时')
        if (image !== undefined && image !== null && !image.isEmpty()) dataUrl = image.toDataURL()
      } catch {
        // The chip still carries the DOM/text; the picture is best-effort.
      }
      const editor = composerEditor()
      if (editor === null) {
        toast('找不到输入框，元素信息已复制到剪贴板')
        try { await navigator.clipboard.writeText(chip.ref) } catch { /* ignore */ }
        return
      }
      const chipped = insertChip(editor.__lexicalEditor, chip)
      editor.focus()
      if (dataUrl !== undefined) {
        try {
          const data = new DataTransfer()
          data.items.add(dataUrlToFile(dataUrl, `element-${Date.now()}.png`))
          if (!chipped) data.setData('text/plain', chip.ref)
          const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true, composed: true })
          if (event.clipboardData !== data) Object.defineProperty(event, 'clipboardData', { value: data })
          editor.dispatchEvent(event)
        } catch {
          // Keep the chip if the paste path is unavailable.
        }
      } else if (!chipped) {
        try {
          document.execCommand('insertText', false, chip.ref)
        } catch {
          await navigator.clipboard.writeText(chip.ref).catch(() => {})
        }
      }
      toast(chipped ? `已加入输入框：${chip.label}` : `已加入输入框：${chip.label}（文本）`)
    }
    //#endregion

    function installViewport() {
      let viewport = readViewport()
      const observed = new WeakMap()
      let scheduled = false
      const scheduleScan = () => {
        if (scheduled) return
        scheduled = true
        setTimeout(() => {
          scheduled = false
          scan()
        }, 120)
      }
      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const frame = entry.target.__dshXSbFrame
          if (frame !== undefined) applyFrame(frame)
        }
      })

      function applyFrame(frame) {
        if (frame.isConnected !== true) return
        const parent = frame.parentElement
        if (parent === null) return
        if (parent.dataset.dshXSbViewport !== '1') {
          parent.dataset.dshXSbViewport = '1'
          parent.style.position = 'relative'
          parent.style.overflow = 'hidden'
        }
        frame.setAttribute('data-dsh-x-fixed-viewport', '')
        const rect = parent.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return
        const scale = viewport.zoom === 'fit'
          ? Math.min(rect.width / viewport.width, rect.height / viewport.height, 1)
          : viewport.zoom / 100
        const left = Math.round((rect.width - viewport.width * scale) / 2)
        const top = Math.round((rect.height - viewport.height * scale) / 2)
        frame.style.setProperty('--dsh-x-sb-width', `${viewport.width}px`)
        frame.style.setProperty('--dsh-x-sb-height', `${viewport.height}px`)
        frame.style.setProperty('--dsh-x-sb-scale', String(scale))
        frame.style.setProperty('--dsh-x-sb-left', `${left}px`)
        frame.style.setProperty('--dsh-x-sb-top', `${top}px`)
        if (!observed.has(parent)) {
          parent.__dshXSbFrame = frame
          observed.set(parent, true)
          resizeObserver.observe(parent)
        } else {
          parent.__dshXSbFrame = frame
        }
        ensureViewportBar(parent)
      }

      function ensureViewportBar(parent) {
        let bar = parent.querySelector(':scope > .dsh-x-sb-viewport-bar')
        if (bar !== null) {
          syncViewportBar(bar)
          return
        }
        bar = document.createElement('div')
        bar.className = 'dsh-x-sb-viewport-bar'

        const widthInput = document.createElement('input')
        widthInput.type = 'number'
        widthInput.min = '320'
        widthInput.max = '4096'
        widthInput.step = '1'
        widthInput.className = 'dsh-x-sb-width'
        widthInput.setAttribute('aria-label', '浏览器视口宽度')
        const times = document.createElement('span')
        times.className = 'dsh-x-sb-times'
        times.textContent = '×'
        const heightInput = document.createElement('input')
        heightInput.type = 'number'
        heightInput.min = '240'
        heightInput.max = '4096'
        heightInput.step = '1'
        heightInput.className = 'dsh-x-sb-height'
        heightInput.setAttribute('aria-label', '浏览器视口高度')

        const zoom = document.createElement('select')
        zoom.className = 'dsh-x-sb-zoom'
        zoom.setAttribute('aria-label', '浏览器缩放')
        for (const value of VIEWPORT_ZOOMS) {
          const option = document.createElement('option')
          option.value = String(value)
          option.textContent = value === 'fit' ? '适应窗口' : `${value}%`
          zoom.append(option)
        }

        const pick = document.createElement('button')
        pick.type = 'button'
        pick.className = 'dsh-x-sb-pick'
        pick.title = '拾取元素加入聊天'
        pick.setAttribute('aria-label', '拾取元素加入聊天')
        pick.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>'
        pick.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          void pickElement(parent)
        })

        const clampNumber = (input, min, max, fallback) => {
          const value = Math.round(Number(input.value))
          if (!Number.isFinite(value)) return fallback
          return Math.min(max, Math.max(min, value))
        }
        const commitSize = () => {
          const width = clampNumber(widthInput, 320, 4096, viewport.width)
          const height = clampNumber(heightInput, 240, 4096, viewport.height)
          viewport = { ...viewport, width, height }
          writeViewport(viewport)
          widthInput.value = String(width)
          heightInput.value = String(height)
          scan()
        }
        widthInput.addEventListener('change', commitSize)
        heightInput.addEventListener('change', commitSize)
        widthInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') commitSize() })
        heightInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') commitSize() })
        zoom.addEventListener('change', () => {
          viewport = { ...viewport, zoom: zoom.value === 'fit' ? 'fit' : Number(zoom.value) }
          writeViewport(viewport)
          scan()
        })

        bar.append(widthInput, times, heightInput, zoom, pick)
        parent.append(bar)
        syncViewportBar(bar)
      }

      function syncViewportBar(bar) {
        const widthInput = bar.querySelector('.dsh-x-sb-width')
        const heightInput = bar.querySelector('.dsh-x-sb-height')
        const zoom = bar.querySelector('.dsh-x-sb-zoom')
        if (widthInput !== null && document.activeElement !== widthInput) widthInput.value = String(viewport.width)
        if (heightInput !== null && document.activeElement !== heightInput) heightInput.value = String(viewport.height)
        if (zoom !== null) zoom.value = String(viewport.zoom)
      }

      function scan() {
        ensureViewportStyle()
        for (const frame of document.querySelectorAll(FRAME_SELECTOR)) applyFrame(frame)
      }

      const observer = new MutationObserver(scheduleScan)
      observer.observe(document.documentElement, { childList: true, subtree: true })
      scan()
      const timer = setInterval(scan, 2000)
      return () => {
        observer.disconnect()
        clearInterval(timer)
        resizeObserver.disconnect()
        document.getElementById(VIEWPORT_STYLE_ID)?.remove()
        for (const bar of document.querySelectorAll('.dsh-x-sb-viewport-bar')) bar.remove()
      }
    }
    //#endregion

    function randomInstanceId() {
      try {
        return 'page-' + crypto.randomUUID()
      } catch {
        return 'page-' + String(Date.now()) + '-' + String(Math.random()).slice(2)
      }
    }

    function apply(ctx) {
      const state = { ctx, last: undefined, running: true }

      ctx.effect(() => installViewport(), 'dsh-x-sidebar-browser: fixed viewport')

      async function post(name, payload, signal) {
        const url = new URL('dsh-x-sidebar-browser/' + name, document.baseURI)
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
          credentials: 'same-origin',
          signal,
        })
        if (response.ok !== true) throw new Error('Sidebar Browser request failed: HTTP ' + String(response.status))
        return await response.json()
      }

      async function loop(signal) {
        const instance = randomInstanceId()
        while (state.running === true && signal.aborted === false) {
          try {
            const session = currentSession(state.ctx)
            const outcome = await post('poll', { instance, session, waitMs: POLL_WAIT_MS }, signal)
            if (signal.aborted || state.running === false) return
            const commands = Array.isArray(outcome && outcome.commands) ? outcome.commands : []
            for (const command of commands) {
              if (signal.aborted || state.running === false) return
              let message
              if (typeof command.session === 'string' && command.session.length > 0
                && command.session !== currentSession(state.ctx)) {
                // The operator switched Sessions between this poll and execution; do not
                // drive a page that belongs to a different Session.
                message = {
                  ok: false,
                  error: { message: 'This browser command belongs to another Session; bring that Session on screen and retry.' },
                }
              } else {
                try {
                  message = { ok: true, value: await executeCommand(state, command) }
                } catch (error) {
                  message = {
                    ok: false,
                    error: { message: error instanceof Error ? error.message : String(error) },
                  }
                }
              }
              try {
                await post('result', { instance, commandId: command.id, ...message }, signal)
              } catch (error) {
                console.error('[dsh-x-sidebar-browser] result post failed', error)
                // A very large screenshot payload can exceed the Host's body limit;
                // retry without the PNG and let the Host capture the guest directly.
                if (message.ok === true && message.value !== null && typeof message.value === 'object'
                  && message.value.png !== undefined && Number.isInteger(message.value.webContentsId)) {
                  try {
                    await post('result', {
                      instance,
                      commandId: command.id,
                      ok: true,
                      value: { text: message.value.text, webContentsId: message.value.webContentsId },
                    }, signal)
                  } catch { /* the Host may have timed the command out */ }
                }
              }
            }
          } catch (error) {
            if (signal.aborted || state.running === false) return
            await sleep(900)
          }
        }
      }

      ctx.effect(() => {
        const controller = new AbortController()
        loop(controller.signal).catch((error) => {
          console.error('[dsh-x-sidebar-browser] poll loop stopped', error)
        })
        return () => {
          state.running = false
          controller.abort()
        }
      }, 'dsh-x-sidebar-browser: command poller')
    }

    return {
      inject: [],
      apply,
    }
  },
})
