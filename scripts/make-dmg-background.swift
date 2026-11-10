// dmg 窗口背景：标题、拖拽箭头、首次打开的放行指引。
//
//     swift scripts/make-dmg-background.swift <out.png> <scale> '<layout json>'
//
// 布局（窗口尺寸、两个图标的中心）由 pack-mac.mjs 传进来，和 Finder 里摆图标用的是同一份数字，
// 这样箭头总是落在两个图标之间。scale=2 出 Retina 版，pack-mac.mjs 用 tiffutil 合成一张多分辨率背景。
import AppKit

struct Layout: Decodable {
  let width: Double
  let height: Double
  let iconSize: Double
  let appX: Double
  let appsX: Double
  let iconY: Double
}

let args = CommandLine.arguments
guard args.count == 4, let scale = Double(args[2]),
      let layout = try? JSONDecoder().decode(Layout.self, from: Data(args[3].utf8)) else {
  FileHandle.standardError.write("usage: make-dmg-background.swift <out.png> <scale> <layout json>\n".data(using: .utf8)!)
  exit(2)
}

// 和启动器页面的 --accent 同色
let accent = NSColor(srgbRed: 0x3b / 255, green: 0x6f / 255, blue: 0xe0 / 255, alpha: 1)
let ink = NSColor(srgbRed: 0x1d / 255, green: 0x24 / 255, blue: 0x33 / 255, alpha: 1)
let muted = NSColor(srgbRed: 0x5b / 255, green: 0x66 / 255, blue: 0x7a / 255, alpha: 1)

let W = layout.width, H = layout.height
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * scale), pixelsHigh: Int(H * scale),
                           bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                           colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: W, height: H)
let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = ctx
// 用左上角为原点的坐标，和 Finder 的图标坐标一致
ctx.cgContext.translateBy(x: 0, y: H)
ctx.cgContext.scaleBy(x: 1, y: -1)
let flipped = NSGraphicsContext(cgContext: ctx.cgContext, flipped: true)
NSGraphicsContext.current = flipped

// 背景：浅蓝到白的竖向渐变
NSGradient(starting: NSColor(srgbRed: 0xea / 255, green: 0xf1 / 255, blue: 1, alpha: 1), ending: .white)!
  .draw(in: NSRect(x: 0, y: 0, width: W, height: H), angle: 90)

func text(_ s: String, size: CGFloat, weight: NSFont.Weight, color: NSColor, at y: Double,
          x: Double = 0, width: Double? = nil, align: NSTextAlignment = .center) {
  let p = NSMutableParagraphStyle()
  p.alignment = align
  p.lineSpacing = 3
  let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color, .paragraphStyle: p,
  ]
  NSAttributedString(string: s, attributes: attrs)
    .draw(in: NSRect(x: x, y: y, width: width ?? W, height: 200))
}

text("Drag DSH-X into Applications", size: 20, weight: .semibold, color: ink, at: 28)
text("把 DSH-X 拖进「应用程序」", size: 13, weight: .regular, color: muted, at: 56)

// 两个图标之间的箭头（图标本身由 Finder 画）
let gap = layout.iconSize / 2 + 28
let y = layout.iconY
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: layout.appX + gap, y: y))
arrow.line(to: NSPoint(x: layout.appsX - gap, y: y))
arrow.move(to: NSPoint(x: layout.appsX - gap - 14, y: y - 12))
arrow.line(to: NSPoint(x: layout.appsX - gap, y: y))
arrow.line(to: NSPoint(x: layout.appsX - gap - 14, y: y + 12))
arrow.lineWidth = 5
arrow.lineCapStyle = .round
arrow.lineJoinStyle = .round
accent.setStroke()
arrow.stroke()

// 首次打开指引卡片：应用没有公证，Gatekeeper 会拦下，要去「隐私与安全性」里放行
let card = NSRect(x: 30, y: H - 150, width: W - 60, height: 128)
NSColor.white.setFill()
let cardPath = NSBezierPath(roundedRect: card, xRadius: 12, yRadius: 12)
cardPath.fill()
accent.withAlphaComponent(0.35).setStroke()
cardPath.lineWidth = 1
cardPath.stroke()
// 左侧色条裁进卡片的圆角里
NSGraphicsContext.saveGraphicsState()
cardPath.addClip()
accent.setFill()
NSRect(x: card.minX, y: card.minY, width: 5, height: card.height).fill()
NSGraphicsContext.restoreGraphicsState()

let pad = 22.0
text("First launch: macOS blocks DSH-X because it isn't notarized", size: 13, weight: .semibold, color: ink,
     at: card.minY + 14, x: card.minX + pad, width: card.width - pad * 2, align: .left)
text("1. Open DSH-X once, then click Done in the warning.\n"
     + "2. Open System Settings → Privacy & Security, scroll down, click Open Anyway.",
     size: 12, weight: .regular, color: ink,
     at: card.minY + 36, x: card.minX + pad, width: card.width - pad * 2, align: .left)
text("首次打开：先打开一次并点「完成」，再到「系统设置 → 隐私与安全性」底部点「仍要打开」。",
     size: 11.5, weight: .regular, color: muted,
     at: card.minY + 90, x: card.minX + pad, width: card.width - pad * 2, align: .left)

NSGraphicsContext.current = nil
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: args[1]))
