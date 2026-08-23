import CoreGraphics
import Foundation

// Interroge CoreGraphics et imprime une ligne par ecran actif, six champs
// separes par une tabulation, sans en-tete :
// largeur px, hauteur px, frequence Hz, largeur pt, hauteur pt, principal (1/0).

let maxDisplays: UInt32 = 16
var displayIDs = [CGDirectDisplayID](repeating: 0, count: Int(maxDisplays))
var displayCount: UInt32 = 0

let listResult = CGGetActiveDisplayList(maxDisplays, &displayIDs, &displayCount)
if listResult != .success {
    FileHandle.standardError.write("display-probe: CGGetActiveDisplayList a echoue\n".data(using: .utf8)!)
    exit(1)
}

for index in 0..<Int(displayCount) {
    let displayID = displayIDs[index]
    guard let mode = CGDisplayCopyDisplayMode(displayID) else { continue }

    let widthPx = mode.pixelWidth
    let heightPx = mode.pixelHeight
    let refreshHz = mode.refreshRate
    let bounds = CGDisplayBounds(displayID)
    let widthPt = Int(bounds.width.rounded())
    let heightPt = Int(bounds.height.rounded())
    let isMain = CGDisplayIsMain(displayID) != 0

    let refreshField = String(format: "%.1f", refreshHz)
    print("\(widthPx)\t\(heightPx)\t\(refreshField)\t\(widthPt)\t\(heightPt)\t\(isMain ? 1 : 0)")
}
