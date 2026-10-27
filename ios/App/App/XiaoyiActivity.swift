// 小芽通话的「实时活动」（锁屏 + 灵动岛）：App 和小组件扩展 XiaoyiWidget 共用这个文件（2026-10-14）。
// 用户：小芽在后台时要一直有个东西显示着，能关麦克风、关声音、直接挂断。iOS 的普通通知挂不住，系统给通话 / 计时这类事的就是实时活动。
// 按钮是 LiveActivityIntent：点了在 App 进程里执行（App 通话中本来就在后台跑着），扩展里只是声明，handler 由 Link.swift 启动时接上

import ActivityKit
import AppIntents
import Foundation

@available(iOS 16.1, *)
struct XiaoyiAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var status: String          // 在听 / 小芽在说话 / 麦克风已关 …
        var text: String            // 小芽最后说的一句（关了声音就靠它看回复）
        var muted: Bool
        var soundOff: Bool
    }
    var start: Date
}

enum XiaoyiControl {
    // App 里换成 LinkEngine 的处理；扩展里什么都不做
    static var handler: (String) -> Void = { _ in }
}

@available(iOS 17.0, *)
struct XiaoyiIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "小芽通话控制"
    static var isDiscoverable: Bool = false

    @Parameter(title: "动作")
    var action: String

    init() { action = "" }
    init(action: String) { self.action = action }

    func perform() async throws -> some IntentResult {
        XiaoyiControl.handler(action)
        return .result()
    }
}
