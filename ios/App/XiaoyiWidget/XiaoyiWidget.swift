// 小组件扩展：小芽通话的实时活动长什么样（锁屏一张卡片、灵动岛展开 / 收起 / 最小）。数据和按钮见 App/XiaoyiActivity.swift

import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct XiaoyiWidgetBundle: WidgetBundle {
    var body: some Widget { XiaoyiLive() }
}

private let green = Color(red: 0.086, green: 0.596, blue: 0.369)      // 嫩芽绿 #16985E，logo 的主色

// 小芽 logo：跟 App 图标同一张——白色圆角底 + 半调芽（小尺寸版 99 个点，坐标是 100x100 方块里的位置）。数据由 logo 工具生成
private let sproutDots: [(Double, Double, Double, UInt32)] = [
    (18.26,28.60,1.10,0x7EC976), (15.24,31.61,1.09,0x7FC977), (24.30,28.60,1.22,0x71C273), (21.28,31.61,1.21,0x72C374), (18.26,34.63,1.20,0x73C474), (15.24,37.66,1.19,0x74C474),
    (30.33,28.60,1.35,0x64BC70), (27.31,31.61,1.34,0x65BD70), (24.30,34.63,1.32,0x66BD71), (21.28,37.66,1.31,0x67BE71), (18.26,40.67,1.30,0x69BF71), (33.35,31.61,1.46,0x58B76D),
    (30.33,34.63,1.45,0x59B76E), (27.31,37.66,1.44,0x5AB86E), (24.30,40.67,1.43,0x5BB86E), (21.28,43.69,1.42,0x5DB96F), (36.36,34.63,1.57,0x4CB16B), (33.35,37.66,1.56,0x4DB26B),
    (30.33,40.67,1.55,0x4EB26B), (27.31,43.69,1.53,0x4FB36B), (24.30,46.71,1.52,0x51B36C), (39.39,37.66,1.68,0x40AB68), (36.36,40.67,1.67,0x41AC68), (33.35,43.69,1.66,0x42AD68),
    (30.33,46.71,1.65,0x43AD69), (27.31,49.72,1.64,0x45AE69), (63.53,19.55,1.40,0x5EBA6F), (60.51,22.56,1.49,0x54B56D), (57.49,25.58,1.58,0x4AB06A), (54.47,28.60,1.68,0x40AC68),
    (42.40,40.67,1.79,0x34A665), (39.39,43.69,1.78,0x35A665), (36.36,46.71,1.78,0x36A766), (33.35,49.72,1.76,0x37A866), (30.33,52.74,1.75,0x39A866), (72.58,16.53,1.20,0x73C374),
    (69.56,19.55,1.30,0x69BF71), (66.55,22.56,1.40,0x5FBA6F), (63.53,25.58,1.48,0x54B56D), (60.51,28.60,1.58,0x4AB06A), (57.49,31.61,1.68,0x40AC68), (54.47,34.63,1.78,0x36A765),
    (51.45,37.66,1.87,0x2CA263), (42.40,46.71,1.89,0x29A162), (39.39,49.72,1.88,0x2AA163), (36.36,52.74,1.87,0x2BA263), (78.61,16.53,1.11,0x7DC876), (75.60,19.55,1.20,0x73C474),
    (72.58,22.56,1.30,0x69BF71), (69.56,25.58,1.40,0x5FBA6F), (66.55,28.60,1.48,0x54B56D), (63.53,31.61,1.58,0x4AB06A), (60.51,34.63,1.68,0x40AC68), (57.49,37.66,1.78,0x36A765),
    (54.47,40.67,1.86,0x2CA263), (51.45,43.69,1.96,0x229D61), (42.40,52.74,2.00,0x1E9C60), (81.63,19.55,1.11,0x7DC876), (78.61,22.56,1.20,0x73C474), (75.60,25.58,1.30,0x69BF71),
    (72.58,28.60,1.39,0x5FBA6F), (69.56,31.61,1.48,0x55B56D), (66.55,34.63,1.58,0x4AB16A), (63.53,37.66,1.68,0x40AC68), (60.51,40.67,1.78,0x36A766), (57.49,43.69,1.86,0x2CA263),
    (54.47,46.71,1.96,0x229E61), (84.66,22.56,1.11,0x7DC876), (81.63,25.58,1.20,0x73C474), (78.61,28.60,1.30,0x69BF71), (75.60,31.61,1.39,0x5FBA6F), (72.58,34.63,1.48,0x55B56D),
    (69.56,37.66,1.58,0x4BB16A), (66.55,40.67,1.68,0x40AC68), (63.53,43.69,1.77,0x36A766), (60.51,46.71,1.86,0x2CA263), (57.49,49.72,1.96,0x229E61), (84.66,28.60,1.20,0x73C474),
    (81.63,31.61,1.29,0x69BF71), (78.61,34.63,1.39,0x5FBA6F), (75.60,37.66,1.48,0x55B56D), (72.58,40.67,1.58,0x4BB16A), (69.56,43.69,1.67,0x41AC68), (66.55,46.71,1.77,0x36A766),
    (63.53,49.72,1.86,0x2CA263), (84.66,34.63,1.29,0x69BF72), (81.63,37.66,1.39,0x5FBA6F), (78.61,40.67,1.48,0x55B66D), (75.60,43.69,1.58,0x4BB16A), (72.58,46.71,1.67,0x41AC68),
    (69.56,49.72,1.77,0x37A766), (48.44,54.47,2.13,0x6BC072), (48.44,58.99,2.13,0x5EB76D), (48.44,63.44,2.07,0x50AE68), (48.44,67.78,2.01,0x44A563), (48.44,71.99,1.95,0x379C5E),
    (48.44,76.07,1.89,0x2B935A), (48.44,80.05,1.83,0x1F8B55), (48.44,83.91,1.78,0x148351),
]

struct Logo: View {
    var size: CGFloat
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.2237, style: .continuous).fill(Color.white)
            Canvas { ctx, sz in
                let k = Double(sz.width) / 100
                for (x, y, r, rgb) in sproutDots {
                    let c = Color(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
                    ctx.fill(Path(ellipseIn: CGRect(x: (x - r) * k, y: (y - r) * k, width: 2 * r * k, height: 2 * r * k)), with: .color(c))
                }
            }
        }
        .frame(width: size, height: size)
    }
}

struct Controls: View {
    let st: XiaoyiAttributes.ContentState
    var body: some View {
        HStack(spacing: 8) {
            Button(intent: XiaoyiIntent(action: "mute")) {
                Label(st.muted ? "开麦" : "关麦", systemImage: st.muted ? "mic.slash.fill" : "mic.fill").frame(maxWidth: .infinity)
            }
            .tint(st.muted ? .orange : .gray)
            Button(intent: XiaoyiIntent(action: "sound")) {
                Label(st.soundOff ? "开声音" : "关声音", systemImage: st.soundOff ? "speaker.slash.fill" : "speaker.wave.2.fill").frame(maxWidth: .infinity)
            }
            .tint(st.soundOff ? .orange : .gray)
            Button(intent: XiaoyiIntent(action: "hang")) {
                Label("挂断", systemImage: "phone.down.fill").frame(maxWidth: .infinity)
            }
            .tint(.red)
        }
        .buttonStyle(.borderedProminent)
        .font(.system(size: 13, weight: .semibold))
        .labelStyle(.titleAndIcon)
    }
}

struct XiaoyiLive: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: XiaoyiAttributes.self) { ctx in
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Logo(size: 34)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("小芽通话中").font(.headline)
                        Text(ctx.state.status).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(timerInterval: ctx.attributes.start...Date.distantFuture, countsDown: false)
                        .font(.system(.title3, design: .rounded).monospacedDigit()).frame(width: 72, alignment: .trailing)
                }
                if !ctx.state.text.isEmpty {
                    Text(ctx.state.text).font(.subheadline).lineLimit(3)
                }
                Controls(st: ctx.state)
            }
            .padding(14)
            .activityBackgroundTint(Color.black.opacity(0.6))
            .activitySystemActionForegroundColor(.white)
            .foregroundStyle(.white)
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Logo(size: 38).padding(.leading, 4).padding(.top, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(timerInterval: ctx.attributes.start...Date.distantFuture, countsDown: false)
                        .font(.system(.callout, design: .rounded).monospacedDigit()).frame(width: 56, alignment: .trailing).padding(.top, 6)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("小芽 · " + ctx.state.status).font(.subheadline.weight(.semibold))
                        if !ctx.state.text.isEmpty { Text(ctx.state.text).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Controls(st: ctx.state).padding(.top, 4)
                }
            } compactLeading: {
                Logo(size: 20)
            } compactTrailing: {
                Image(systemName: ctx.state.muted ? "mic.slash.fill" : ctx.state.soundOff ? "speaker.slash.fill" : "waveform")
                    .foregroundStyle(ctx.state.muted || ctx.state.soundOff ? Color.orange : green)
            } minimal: {
                Logo(size: 18)
            }
            .keylineTint(green)
        }
    }
}
