import CoreGraphics
import ColorSync
import Foundation

// Interroge CoreGraphics et imprime une ligne par ecran actif, six champs
// separes par une tabulation, sans en-tete :
// largeur px, hauteur px, frequence Hz, largeur pt, hauteur pt, principal (1/0),
// profil ColorSync actif, profil display/RGB valide (1/0).

func colorProfile(for displayID: CGDirectDisplayID) -> (name: String, valid: Bool) {
    let uuid = CGDisplayCreateUUIDFromDisplayID(displayID).takeRetainedValue()
    let deviceClass = kColorSyncDisplayDeviceClass.takeUnretainedValue()
    guard let rawInfo = ColorSyncDeviceCopyDeviceInfo(deviceClass, uuid) else {
        return ("-", false)
    }

    let info = rawInfo.takeRetainedValue() as NSDictionary
    let factoryKey = kColorSyncFactoryProfiles.takeUnretainedValue() as String
    let customKey = kColorSyncCustomProfiles.takeUnretainedValue() as String
    let defaultKey = kColorSyncDeviceDefaultProfileID.takeUnretainedValue() as String
    let urlKey = kColorSyncDeviceProfileURL.takeUnretainedValue() as String

    guard
        let factory = info[factoryKey] as? NSDictionary,
        let profileID = factory[defaultKey]
    else {
        return ("-", false)
    }

    let custom = info[customKey] as? NSDictionary
    let customURL = custom?[profileID] as? URL
    let factoryProfile = factory[profileID] as? NSDictionary
    guard let url = customURL ?? (factoryProfile?[urlKey] as? URL) else {
        return ("-", false)
    }
    guard let rawProfile = ColorSyncProfileCreateWithURL(url as CFURL, nil) else {
        return (url.deletingPathExtension().lastPathComponent, false)
    }

    let profile = rawProfile.takeRetainedValue()
    let description = ColorSyncProfileCopyDescriptionString(profile)?
        .takeRetainedValue() as String?
    let safeName = (description ?? url.deletingPathExtension().lastPathComponent)
        .replacingOccurrences(of: "\t", with: " ")
        .replacingOccurrences(of: "\n", with: " ")

    let header = ColorSyncProfileCopyHeader(profile).takeRetainedValue() as Data
    guard header.count >= 20 else { return (safeName, false) }
    let profileClass = String(data: header[12..<16], encoding: .ascii)
    let colorSpace = String(data: header[16..<20], encoding: .ascii)
    // ColorSync rend les signatures ICC comme des UInt32 en ordre natif ; sur
    // les Mac little-endian, les quatre octets lisibles sont donc inverses.
    return (safeName, profileClass == "rtnm" && colorSpace == " BGR")
}

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
    let profile = colorProfile(for: displayID)

    let refreshField = String(format: "%.1f", refreshHz)
    print("\(widthPx)\t\(heightPx)\t\(refreshField)\t\(widthPt)\t\(heightPt)\t\(isMain ? 1 : 0)\t\(profile.name)\t\(profile.valid ? 1 : 0)")
}
