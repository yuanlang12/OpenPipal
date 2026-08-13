import AppKit

let syswide = AXUIElementCreateSystemWide()
var focusedApp: AnyObject?
AXUIElementCopyAttributeValue(syswide, kAXFocusedApplicationAttribute as CFString, &focusedApp)

guard let app = focusedApp else {
    print("{}")
    exit(0)
}

func axStr(_ elem: AXUIElement, _ attr: String) -> String {
    var val: AnyObject?
    AXUIElementCopyAttributeValue(elem, attr as CFString, &val)
    return (val as? String) ?? ""
}

let appEl = app as! AXUIElement
let appName = axStr(appEl, kAXTitleAttribute as String)

var winTitle = ""
var focusedWin: AnyObject?
AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focusedWin)
if let w = focusedWin {
    winTitle = axStr(w as! AXUIElement, kAXTitleAttribute as String)
}

var role = ""
var value = ""
var selected = ""
var focusedElem: AnyObject?
AXUIElementCopyAttributeValue(appEl, kAXFocusedUIElementAttribute as CFString, &focusedElem)
if let fe = focusedElem {
    let el = fe as! AXUIElement
    role = axStr(el, kAXRoleAttribute as String)
    let rawVal = axStr(el, kAXValueAttribute as String)
    value = rawVal.count > 500 ? String(rawVal.prefix(500)) : rawVal
    selected = axStr(el, kAXSelectedTextAttribute as String)
    if selected.count > 500 { selected = String(selected.prefix(500)) }
}

func esc(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
     .replacingOccurrences(of: "\"", with: "\\\"")
     .replacingOccurrences(of: "\n", with: "\\n")
     .replacingOccurrences(of: "\r", with: "")
     .replacingOccurrences(of: "\t", with: "\\t")
}

print("{\"app\":\"\(esc(appName))\",\"window\":\"\(esc(winTitle))\",\"role\":\"\(esc(role))\",\"value\":\"\(esc(value))\",\"selected\":\"\(esc(selected))\"}")
