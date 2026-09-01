import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
  fputs("Usage: swift electron/generate-icon.swift <source.png> <output.png>\n", stderr)
  exit(64)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])

guard let logo = NSImage(contentsOf: sourceURL) else {
  fputs("Could not load source icon at \(sourceURL.path)\n", stderr)
  exit(66)
}

let canvasSize = NSSize(width: 1024, height: 1024)
guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(canvasSize.width),
  pixelsHigh: Int(canvasSize.height),
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fputs("Could not create icon canvas\n", stderr)
  exit(70)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.cgContext.clear(CGRect(origin: .zero, size: canvasSize))
context.imageInterpolation = .high

let tileRect = NSRect(x: 100, y: 100, width: 824, height: 824)
let tile = NSBezierPath(roundedRect: tileRect, xRadius: 185, yRadius: 185)

NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor(calibratedWhite: 0.08, alpha: 0.24)
shadow.shadowBlurRadius = 22
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.set()
NSColor(calibratedWhite: 0.975, alpha: 1).setFill()
tile.fill()
NSGraphicsContext.restoreGraphicsState()

NSColor(calibratedWhite: 0.975, alpha: 1).setFill()
tile.fill()
NSColor(calibratedWhite: 0.72, alpha: 0.75).setStroke()
tile.lineWidth = 3
tile.stroke()

// Keep the original Pi speech-bubble pixels unchanged, but bring the artwork
// inside the macOS icon safe area so Dock and Launchpad have matching bounds.
let logoRect = NSRect(x: 247, y: 238, width: 530, height: 530)
logo.draw(
  in: logoRect,
  from: NSRect(origin: .zero, size: logo.size),
  operation: .sourceOver,
  fraction: 1,
  respectFlipped: true,
  hints: [.interpolation: NSImageInterpolation.high]
)

NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
  fputs("Could not encode icon PNG\n", stderr)
  exit(70)
}

do {
  try png.write(to: outputURL, options: .atomic)
  print("Wrote \(outputURL.path)")
} catch {
  fputs("Could not write icon: \(error)\n", stderr)
  exit(73)
}
