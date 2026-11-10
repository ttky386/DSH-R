/**
 * 装饰动画的空闲开关：没人动的时候别一直画。
 *
 * 看板娘和水波是纯装饰，但两个 rAF 循环一直跑。实测（旧 WebView2 外壳）这个页面可见时稳定吃掉
 * 约一个 CPU 核（渲染进程 43% + GPU 进程 69%，同一份页面在 Edge 里只要 ~15%），挂几天
 * 就是用户报的「启动器占着 1GB 内存、系统一直换页」。90 秒没有任何输入就把 html 标成
 * launcher-idle：mascot.js / water.js 的 active() 都看这个类，两个循环自己就停（它们本来
 * 就监听 documentElement 的 class，恢复同理，不用额外接线）；任何输入立刻摘掉。
 */
(() => {
  const IDLE_MS = 90000
  const root = document.documentElement
  let last = performance.now()
  const wake = () => {
    last = performance.now()
    // 没有这个类时 remove 不会写属性，也就不会惊动那两个 MutationObserver。
    if (root.classList.contains('launcher-idle')) root.classList.remove('launcher-idle')
  }
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'touchstart', 'focus']) {
    window.addEventListener(name, wake, { passive: true, capture: true })
  }
  // 定时看而不是每次输入都重设定时器：指针一动就是几十次事件，没必要每次都动 api。
  setInterval(() => {
    // 页面本来就不可见时不用管（循环自己会停）；这里只处理「看得见但没人在用」。
    if (document.hidden || performance.now() - last < IDLE_MS) return
    if (!root.classList.contains('launcher-idle')) root.classList.add('launcher-idle')
  }, 5000)
})()
