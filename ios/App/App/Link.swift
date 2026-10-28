// 原生 Link（2026-10-14，安装包 v3）：长连接 + 录音 + 朗读 + 后台 + 通知。跟安卓的 Link.java 一一对应，协议见 server.py「手机 App v2」。
// 为什么放原生：WKWebView 里的麦克风 / AudioContext 只认点击手势、会被静音键掐掉、开着麦声音走听筒、一切后台就停
// （用户反馈：苹果小芽收不到音、朗读没声音、锁屏后断）。这里用 AVAudioEngine：声音会话 playAndRecord + 默认外放，不受静音键影响，
// Info.plist 的 UIBackgroundModes=audio 让通话时锁屏照样收音；Claude 干活时开着「后台运行」就放一段静音保活，做完弹本地通知。
// 网页那边：Capacitor.registerPlugin("Link")，方法 start / stop / send / ptt / live / spStop / bg / perm / status / pick，事件 msg / conn / lv / sp / live / resume / aec

import ActivityKit
import AVFoundation
import Capacitor
import PhotosUI
import Speech
import UIKit
import UniformTypeIdentifiers
import UserNotifications

// 根控制器：注册 Link（App 里自带的插件，不走 npm 包）
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(LinkPlugin())
    }
}

@objc(LinkPlugin)
public class LinkPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LinkPlugin"
    public let jsName = "Link"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ptt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "live", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "spStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sound", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "bg", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "perm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise),
    ]
    let L = LinkEngine.shared

    override public func load() {
        L.emit = { [weak self] name, data in self?.notifyListeners(name, data: data) }
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.L.setFg(false) }
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.L.setFg(true) }
        bridge?.notificationRouter.localNotificationHandler = self
    }

    @objc func start(_ call: CAPPluginCall) {
        let sv = (call.getString("servers") ?? "").split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" }).map(String.init)
        L.q.async { self.L.start(sv, call.getString("token") ?? "", call.getString("hello") ?? "") }
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) { L.q.async { self.L.stop() }; call.resolve() }

    @objc func send(_ call: CAPPluginCall) {
        let s = call.getString("s") ?? ""
        L.q.async { call.resolve(["ok": self.L.send(s)]) }
    }

    @objc func ptt(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false, msg = call.getString("msg") ?? ""
        if !on { L.q.async { self.L.pttStop(msg); call.resolve() }; return }
        LinkEngine.micPermission { ok in
            guard ok else { call.reject("没有麦克风权限，到 设置 > 小芽 里打开"); return }
            self.L.q.async {
                if let err = self.L.pttStart(msg) { call.reject(err) } else { call.resolve() }
            }
        }
    }

    @objc func live(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        if !on { let vs = call.getInt("vs") ?? 0; L.q.async { self.L.liveStop(vs); call.resolve() }; return }
        let mute = call.getBool("mute") ?? false
        LinkEngine.micPermission { ok in
            guard ok else { call.reject("没有麦克风权限，到 设置 > 小芽 里打开"); return }
            self.L.q.async {
                if let err = self.L.liveStart(mute) { call.reject(err) } else { call.resolve(["la": self.L.laState, "aec": self.L.echoSafe]) }
            }
        }
    }

    @objc func spStop(_ call: CAPPluginCall) { L.q.async { self.L.spStop(tell: true) }; call.resolve() }

    @objc func sound(_ call: CAPPluginCall) {
        let off = call.getBool("off") ?? false
        L.q.async { self.L.setSound(off) }
        call.resolve()
    }

    @objc func bg(_ call: CAPPluginCall) {
        let keep = call.getBool("keep") ?? true, notify = call.getBool("notify") ?? true, busy = call.getBool("busy") ?? false
        L.q.async { self.L.setBg(keep: keep, notify: notify, busy: busy) }
        if notify { LinkEngine.notePermission() }
        call.resolve()
    }

    @objc func perm(_ call: CAPPluginCall) { LinkEngine.notePermission(); call.resolve() }

    @objc func status(_ call: CAPPluginCall) {
        L.q.async { call.resolve(["live": self.L.liveOn, "sp": self.L.speaking, "up": self.L.up, "mute": self.L.liveMuted, "sound": self.L.soundOff]) }
    }

    // 附件（2026-10-16，安装包 v4。用户：点「图片」后弹「照片图库 / 拍照 / 选取文件」三个选项悬在半空、输入栏都不见了，很丑）：
    // 网页的 <input type=file> 在 iOS 上一律先弹这个菜单、跳不过去，所以相册、文件由这里直接打开系统的选择界面——
    // 相册 = PHPicker（不用相册权限，HEIC 自动转成 JPEG），文件 = 文件 App。选中的拷进临时目录（文件名换成纯英文，网页按路径读不出岔子），
    // 回 {files: [{path, name, mime}]}，网页用 Capacitor.convertFileSrc 读出来再走原来的压缩上传；取消回空列表。拍照还是网页的 capture，本来就直接开相机
    private var pickCall: CAPPluginCall?

    @objc func pick(_ call: CAPPluginCall) {
        let files = call.getString("kind") == "files", limit = max(1, call.getInt("max") ?? 9)
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { call.reject("打不开选择界面"); return }
            self.pickCall?.resolve(["files": []])
            self.pickCall = call
            if files {
                let p = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
                p.allowsMultipleSelection = limit > 1
                p.delegate = self
                vc.present(p, animated: true)
            } else {
                var cf = PHPickerConfiguration()
                cf.filter = .images
                cf.selectionLimit = limit
                cf.preferredAssetRepresentationMode = .compatible
                let p = PHPickerViewController(configuration: cf)
                p.delegate = self
                vc.present(p, animated: true)
            }
        }
    }

    private func pickDone(_ files: [[String: String]]) {
        DispatchQueue.main.async { self.pickCall?.resolve(["files": files]); self.pickCall = nil }
    }

    // 拷一份进临时目录的 pick/ 下：路径只有英文和数字
    private static func pickCopy(_ src: URL, name: String) -> [String: String]? {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pick", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let ext = src.pathExtension, dst = dir.appendingPathComponent(UUID().uuidString + (ext.isEmpty ? "" : "." + ext))
        do { try FileManager.default.copyItem(at: src, to: dst) } catch { return nil }
        return ["path": dst.path, "name": name, "mime": UTType(filenameExtension: ext)?.preferredMIMEType ?? ""]
    }
}

extension LinkPlugin: PHPickerViewControllerDelegate, UIDocumentPickerDelegate {
    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        let out = PickBox(results.count), group = DispatchGroup()
        for (i, r) in results.enumerated() {
            let p = r.itemProvider
            guard p.hasItemConformingToTypeIdentifier(UTType.image.identifier) else { continue }
            group.enter()
            p.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in   // url 出了这个回调就被删，当场拷走
                defer { group.leave() }
                guard let url = url else { return }
                let ext = url.pathExtension.isEmpty ? "jpg" : url.pathExtension
                out.set(i, LinkPlugin.pickCopy(url, name: (p.suggestedName ?? "图片\(i + 1)") + "." + ext))
            }
        }
        group.notify(queue: .main) { self.pickDone(out.files) }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        pickDone(urls.compactMap { LinkPlugin.pickCopy($0, name: $0.lastPathComponent) })
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { pickDone([]) }
}

// 几张图并行拷，按选的顺序收齐
private final class PickBox: @unchecked Sendable {
    private var a: [[String: String]?]
    private let lock = NSLock()
    init(_ n: Int) { a = Array(repeating: nil, count: n) }
    func set(_ i: Int, _ v: [String: String]?) { lock.lock(); a[i] = v; lock.unlock() }
    var files: [[String: String]] { lock.lock(); defer { lock.unlock() }; return a.compactMap { $0 } }
}

// App 在前台时：定时提醒照样弹系统横幅（2026-10-16 起 App 里不再弹提示，在别的页面上会错过）；别的通知前台本来就不发
extension LinkPlugin: NotificationHandlerProtocol {
    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        notification.request.content.threadIdentifier == "cron" ? [.banner, .list, .sound] : []
    }

    public func didReceive(response: UNNotificationResponse) {}
}

// ---------------------------------------------------------------- IMA ADPCM（跟 server.py / app.js 同一套表）
private let STEP: [Int32] = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
    107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
    7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767]
private let IDX: [Int32] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]

struct Adpcm {
    var pred: Int32 = 0, idx: Int32 = 0, half: Int32 = -1
    var buf = [UInt8]()
    mutating func reset() { pred = 0; idx = 0; half = -1; buf.removeAll() }
    mutating func dec(_ n: Int32) -> Int32 {
        let step = STEP[Int(idx)]
        var diff = step >> 3
        if n & 4 != 0 { diff += step }
        if n & 2 != 0 { diff += step >> 1 }
        if n & 1 != 0 { diff += step >> 2 }
        pred = max(-32768, min(32767, n & 8 != 0 ? pred - diff : pred + diff))
        idx = max(0, min(88, idx + IDX[Int(n)]))
        return pred
    }
    mutating func enc(_ s: Int32) -> Int32 {
        let step = STEP[Int(idx)]
        var diff = s - pred, n: Int32 = 0
        if diff < 0 { n = 8; diff = -diff }
        if diff >= step { n |= 4; diff -= step }
        if diff >= step >> 1 { n |= 2; diff -= step >> 1 }
        if diff >= step >> 2 { n |= 1 }
        _ = dec(n)
        return n
    }
    // 上传：低半字节在前
    mutating func feed(_ p: [Int16]) {
        for s in p {
            let n = enc(Int32(s))
            if half < 0 { half = n } else { buf.append(UInt8(half | n << 4)); half = -1 }
        }
    }
    mutating func take(all: Bool) -> [UInt8]? {
        if all && half >= 0 { buf.append(UInt8(half)); half = -1 }
        let k = all ? buf.count : buf.count - buf.count % 160
        if k == 0 { return nil }
        let o = Array(buf[0..<k])
        buf.removeFirst(k)
        return o
    }
}

// ---------------------------------------------------------------- 系统语音识别（2026-10-28）
// 原来按住说话、小智 / 小芽通话都把音频传给服务器，服务器调百炼识别：要花钱，还会把中文短句听成英文。
// 现在 hello 带 stt:1，服务器还是按音量切句，但切好后不送百炼，而是发 stt 请求「第 a~b 个采样」（s = ptt 按住说话 / live 通话，
// 采样序号从这一路上行音频的第一个算起，跟服务器数的一样），手机用系统自带的 SFSpeechRecognizer（zh-CN，能离线就离线）识别自己录下的这段，
// 把文字回给服务器（stt 回复）。没授权 / 系统识别不可用 / 出错就回 err，服务器退回百炼。
struct SttRing {
    var base = 0                                  // s[0] 是这一路上行音频的第几个采样
    var s = [Int16]()
    mutating func reset() { base = 0; s.removeAll(keepingCapacity: true) }
    mutating func add(_ f: [Int16]) {
        s.append(contentsOf: f)
        if s.count > 16000 * 95 { let d = 16000 * 5; s.removeFirst(d); base += d }      // 只留最近约 90 秒，成批丢
    }
    func slice(_ a: Int, _ b: Int) -> [Int16]? {
        let lo = a - base, hi = min(b - base, s.count)
        guard lo >= 0, hi > lo else { return nil }
        return Array(s[lo..<hi])
    }
}

final class SysSpeech {
    private final class Job {
        let pcm: [Int16], ctx: [String], done: (String?, String?, Bool) -> Void
        var over = false, last = ""
        var task: SFSpeechRecognitionTask?
        init(_ p: [Int16], _ c: [String], _ d: @escaping (String?, String?, Bool) -> Void) { pcm = p; ctx = c; done = d }
    }

    private let q: DispatchQueue                   // 所有状态都在 LinkEngine 的 q 上动
    private let rec = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private var waiting = [Job](), cur: Job?
    init(_ q: DispatchQueue) { self.q = q }

    static var available: Bool { SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) != nil }

    // 开麦的时候顺便让系统弹一次授权，别等到第一句要识别了才弹
    static func askPermission() {
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined { SFSpeechRecognizer.requestAuthorization { _ in } }
    }

    /// 在 q 上调，done 也在 q 上回：(文字, 错误, 是不是没授权)。一次只识别一段，后面的排队
    func run(_ pcm: [Int16], ctx: [String], done: @escaping (String?, String?, Bool) -> Void) {
        waiting.append(Job(pcm, ctx, done))
        next()
    }

    private func next() {
        guard cur == nil, !waiting.isEmpty else { return }
        let j = waiting.removeFirst()
        cur = j
        begin(j)
    }

    private func end(_ j: Job, _ text: String?, _ err: String? = nil, deny: Bool = false) {
        guard !j.over else { return }
        j.over = true
        j.task?.cancel()
        j.done(text, err, deny)
        cur = nil
        next()
    }

    private func begin(_ j: Job) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: break
        case .notDetermined:                       // 授权弹窗还在等用户点：点完再办
            SFSpeechRecognizer.requestAuthorization { [weak self] st in
                self?.q.async {
                    if st == .authorized { self?.begin(j) } else { self?.end(j, nil, "没有语音识别权限，到 设置 > 小芽 里打开", deny: true) }
                }
            }
            return
        default:
            return end(j, nil, "没有语音识别权限，到 设置 > 小芽 里打开", deny: true)
        }
        guard let r = rec, r.isAvailable else { return end(j, nil, "系统语音识别现在不可用") }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true      // 超时的时候至少有最近一次的中间结果可用
        req.addsPunctuation = true
        req.taskHint = .dictation
        req.contextualStrings = j.ctx              // 「Claude」「小芽」「小智」这类词，服务器随请求给
        if r.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        j.task = r.recognitionTask(with: req) { [weak self] res, err in
            self?.q.async {
                guard let self = self, !j.over else { return }
                if let res = res {
                    j.last = res.bestTranscription.formattedString
                    if res.isFinal { return self.end(j, j.last) }
                }
                if let err = err as NSError? {
                    if !j.last.isEmpty { self.end(j, j.last) }
                    else if err.code == 1110 { self.end(j, "") }          // No speech detected：这段里没有人话
                    else { self.end(j, nil, "\(err.localizedDescription)（\(err.domain) \(err.code)）") }
                }
            }
        }
        var i = 0
        while i < j.pcm.count {                    // 0.5 秒一块喂进去，比实时快
            let n = min(8000, j.pcm.count - i)
            guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(n)), let ch = buf.floatChannelData?[0] else { break }
            buf.frameLength = AVAudioFrameCount(n)
            for k in 0..<n { ch[k] = Float(j.pcm[i + k]) / 32768 }
            req.append(buf)
            i += n
        }
        req.endAudio()
        let dur = Double(j.pcm.count) / 16000
        q.asyncAfter(deadline: .now() + 8 + dur * 0.4) { [weak self] in                 // 比服务器的等待（10 秒 + 0.5 倍时长）早一点
            guard let self = self, !j.over else { return }
            if j.last.isEmpty { self.end(j, nil, "系统语音识别超时") } else { self.end(j, j.last) }
        }
    }
}

final class LinkEngine: NSObject {
    static let shared = LinkEngine()
    let q = DispatchQueue(label: "esplink.link")
    var emit: ((String, [String: Any]) -> Void)?

    // ---------------------------------------------------------------- 连接
    private var servers = [String](), token = "", hello = ""
    private var srv = 0, want = false, heard = false, pingSeq = 0
    private(set) var up = false
    private var lastRx = Date()
    private var task: URLSessionWebSocketTask?
    private var host = ""
    private lazy var session = URLSession(configuration: .default)
    private var timer: DispatchSourceTimer?
    var fg = true
    private var keep = true, notify = true, busy = false

    override init() {
        super.init()
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + 5, repeating: 5)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(audioInterrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(engineChanged(_:)), name: .AVAudioEngineConfigurationChange, object: nil)
        nc.addObserver(self, selector: #selector(mediaReset(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        nc.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        XiaoyiControl.handler = { [weak self] a in self?.q.async { self?.control(a) } }
        if #available(iOS 16.2, *) {
            Task { for a in Activity<XiaoyiAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) } }
        }
    }

    // hello 里加上 stt:1：这个安装包能用系统语音识别（老安装包、安卓没有这一项，服务器就继续调百炼）
    private static func withStt(_ h: String) -> String {
        guard SysSpeech.available, let d = h.data(using: .utf8), var m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return h }
        m["stt"] = 1
        guard let o = try? JSONSerialization.data(withJSONObject: m), let s = String(data: o, encoding: .utf8) else { return h }
        return s
    }

    func start(_ sv: [String], _ tok: String, _ hel: String) {
        servers = sv; token = tok; hello = LinkEngine.withStt(hel)
        want = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connect()
    }

    func stop() {
        want = false
        liveOn = false; pttOn = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        up = false
        spStop(tell: false)
        micMaybeIdle()
        updateBg()
    }

    private func connect() {
        guard want, task == nil, !servers.isEmpty else { return }
        host = servers[srv % servers.count]
        heard = false
        let key = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        guard let url = URL(string: "ws://\(host)/ws?key=\(key)") else { return }
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        lastRx = Date()
        t.send(.string(hello)) { _ in }
        receive(t)
        q.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self = self, self.task === t, !self.heard else { return }
            t.cancel(with: .goingAway, reason: nil)
            self.down(t)
        }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] r in
            guard let self = self else { return }
            self.q.async {
                guard self.task === t else { return }
                switch r {
                case .success(let m):
                    self.heard = true
                    self.lastRx = Date()
                    if case .string(let s) = m { self.onText(s) }
                    self.receive(t)
                case .failure:
                    self.down(t)
                }
            }
        }
    }

    private func down(_ t: URLSessionWebSocketTask) {
        guard task === t else { return }
        task = nil
        up = false
        if !heard { srv += 1 }           // 连上了却一个字没回 / 连不上：换下一个地址（先北京中转再直连硅谷）
        pttOn = false
        spStop(tell: false)
        emit?("conn", ["on": false, "host": host, "why": ""])
        if want { q.asyncAfter(deadline: .now() + (heard ? 0.5 : 1.5)) { [weak self] in self?.connect() } }
    }

    @discardableResult
    func send(_ s: String) -> Bool {
        guard let t = task, up else { return false }
        t.send(.string(s)) { _ in }
        return true
    }

    private func tick() {
        guard let t = task, up else { return }
        pingSeq += 1
        t.send(.string("{\"t\":\"ping\",\"seq\":\(pingSeq)}")) { _ in }
        if Date().timeIntervalSince(lastRx) > 15 { t.cancel(with: .goingAway, reason: nil); down(t) }   // 服务器每 5 秒发 ka
    }

    private func onText(_ s: String) {
        guard let d = s.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let t = m["t"] as? String else { return }
        switch t {
        case "hello":
            if (m["login"] as? Int ?? 0) == 0 {
                up = true
                emit?("conn", ["on": true, "host": host, "why": ""])
                if liveOn { liveEnc.reset(); sttLive.reset(); send("{\"t\":\"rec\",\"wc\":15}") }   // 断线重连：小芽接着听
            }
        case "auth": want = false
        case "ka", "pong", "sp_mark", "ack", "cfg", "sp_end": return
        case "sp_start": spStart(m["n"] as? Int ?? 0, m["fmt"] as? String ?? ""); return
        case "sp": spData(m["n"] as? Int ?? 0, m["d"] as? String ?? ""); return
        case "snd": beep(m["k"] as? String ?? ""); return
        case "stt": sttRequest(m); return
        case "rec_stop":
            if liveOn { liveOn = false; soundOff = false; micMaybeIdle(); updateBg(); activityUpdate(); emit?("live", ["on": false, "why": "stop"]) }
        case "note": note(m)
        case "alarms": alarms(m); return
        default: break
        }
        // 在后台时网页会被挂起：只转请求的回复和连接相关的，别的回前台再整页重拉（resume 事件）
        if fg || t == "r" || t == "hello" || t == "auth" { emit?("msg", ["s": s]) }
    }

    func setFg(_ f: Bool) {
        q.async {
            self.fg = f
            if f {
                self.emit?("resume", ["live": self.liveOn, "sp": self.speaking])
                self.emit?("ctl", ["mute": self.liveMuted, "sound": self.soundOff])
                if self.liveOn { self.activityUpdate() }
            }
            self.updateBg()
        }
    }

    // ---------------------------------------------------------------- 通话控制（App 里的按钮、锁屏 / 灵动岛上的按钮都走这里）
    private(set) var soundOff = false               // 关闭声音：小芽照样听、照样回，只是不念（服务器当场停合成，回复看文字）
    private var liveText = ""
    private var activity: Any?                       // Activity<XiaoyiAttributes>（iOS 16.2+）

    func setSound(_ off: Bool) {
        soundOff = off
        if off { spStop(tell: true) }
        ctlChanged()
    }

    func control(_ a: String) {
        switch a {
        case "mute": liveMuted.toggle(); ctlChanged()
        case "sound": setSound(!soundOff)
        case "hang":
            if liveOn { liveStop(2); emit?("live", ["on": false, "why": "hang"]) }
        default: break
        }
    }

    private func ctlChanged() {
        emit?("ctl", ["mute": liveMuted, "sound": soundOff])
        activityUpdate()
    }

    private func liveStatus() -> String {
        liveMuted ? "麦克风已关" : speaking ? "小芽在说话" : soundOff ? "在听 · 声音已关" : "在听"
    }

    // 小组件扩展装上了没有、用的哪张描述文件（2026-10-14 灵动岛不出来：SideStore 装的时候会问扩展怎么办，
    // 选 Remove 就没了；选 Use Main Profile 是跟主程序共用一张描述文件）。报给服务器的日志里有这一串，排查用
    static let widgetInfo: (noext: Bool, desc: String) = {
        guard let u = Bundle.main.builtInPlugInsURL?.appendingPathComponent("XiaoyiWidget.appex"),
              let id = Bundle(url: u)?.bundleIdentifier else { return (true, "没有小组件扩展") }
        guard let d = try? Data(contentsOf: u.appendingPathComponent("embedded.mobileprovision")),
              let s = d.range(of: Data("<?xml".utf8)), let e = d.range(of: Data("</plist>".utf8), in: s.lowerBound..<d.endIndex),
              let p = (try? PropertyListSerialization.propertyList(from: d.subdata(in: s.lowerBound..<e.upperBound), options: [], format: nil)) as? [String: Any],
              let appId = (p["Entitlements"] as? [String: Any])?["application-identifier"] as? String
        else { return (false, "扩展 \(id) 没有描述文件") }
        return (false, "扩展 \(id) 描述文件 \(appId)")
    }()

    // 最近一次建实时活动的结果：ok / noext（安装时扩展被去掉）/ off（设置里关了实时活动）/ err:…，回给网页提示，也报给服务器
    private(set) var laState = ""

    // 实时活动：通话开始（App 在前台）时建，状态变了就更新，挂断收掉
    private func activityUpdate() {
        guard #available(iOS 16.2, *) else { return }
        // 实时活动的数据整个不能超过 4KB，超了 update 不生效；锁屏 / 灵动岛上最多也就显示三行
        let st = XiaoyiAttributes.ContentState(status: liveStatus(), text: String(liveText.prefix(120)), muted: liveMuted, soundOff: soundOff)
        if liveOn {
            // 用户在锁屏上划掉了、或者系统收掉了，就重新建（只有在前台建得起来，所以回前台时 setFg 也会走到这里）
            if let a = activity as? Activity<XiaoyiAttributes>, a.activityState == .active || a.activityState == .stale {
                Task { await a.update(ActivityContent(state: st, staleDate: nil)) }
                return
            }
            activity = nil
            var r = "ok"
            if !ActivityAuthorizationInfo().areActivitiesEnabled { r = "off" }
            else {
                do {
                    activity = try Activity.request(attributes: XiaoyiAttributes(start: Date()), content: ActivityContent(state: st, staleDate: nil), pushType: nil)
                } catch { r = "err:\(error)" }
            }
            if r == "ok" && LinkEngine.widgetInfo.noext { r = "noext" }
            if r != laState {
                laState = r
                NSLog("EspLink 实时活动 \(r) \(LinkEngine.widgetInfo.desc)")
                if let d = try? JSONSerialization.data(withJSONObject: ["t": "la", "i": "\(r) | \(LinkEngine.widgetInfo.desc) | \(ProcessInfo.processInfo.operatingSystemVersionString)"]),
                   let s = String(data: d, encoding: .utf8) { send(s) }
            }
        } else if let a = activity as? Activity<XiaoyiAttributes> {
            activity = nil
            liveText = ""
            Task { await a.end(ActivityContent(state: st, staleDate: nil), dismissalPolicy: .immediate) }
        }
    }

    // ---------------------------------------------------------------- 声音会话 + 引擎
    // playAndRecord + 默认外放：不受静音键影响（网页里的 Web Audio 会被静音键掐掉），开着麦也不会切到听筒；
    // mixWithOthers：不打断别的 App 的音乐（Claude 干活时的静音保活也不会把音乐停掉），在后台也能开声音
    private let playEng = AVAudioEngine(), player = AVAudioPlayerNode(), player24 = AVAudioPlayerNode(), keeper = AVAudioPlayerNode()
    private let fmt16 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private let fmt24 = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
    private var playWired = false
    private var micEng: AVAudioEngine?

    private func audioSession() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .mixWithOthers])
        try? s.setActive(true)
    }

    private func ensurePlay() -> Bool {
        audioSession()
        if !playWired {
            playEng.attach(player)
            playEng.attach(player24)
            playEng.attach(keeper)
            playEng.connect(player, to: playEng.mainMixerNode, format: fmt16)
            playEng.connect(player24, to: playEng.mainMixerNode, format: fmt24)
            playEng.connect(keeper, to: playEng.mainMixerNode, format: fmt16)
            playWired = true
        }
        if !playEng.isRunning {
            playEng.prepare()
            do { try playEng.start() } catch { NSLog("EspLink 放音引擎起不来 \(error)"); return false }
        }
        return true
    }

    @objc private func audioInterrupted(_ n: Notification) {
        guard let v = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, AVAudioSession.InterruptionType(rawValue: v) == .ended else { return }
        q.async { self.restartAudio() }          // 来电等打断结束：接着收音 / 放音
    }

    // 引擎配置变了（插拔耳机、麦克风那台引擎一开放音引擎也会收到）：哪台变了重启哪台，别连带重建麦克风（会来回触发）
    @objc private func engineChanged(_ n: Notification) {
        let e = n.object as? AVAudioEngine
        q.async {
            if e === self.playEng {
                if self.speaking || self.keeping { _ = self.ensurePlay(); self.spNode.play(); if self.keeping { self.keeper.play() } }
            } else if let m = self.micEng, e === m, self.liveOn || self.pttOn {
                self.closeMicEngine()
                _ = self.openMic()
            }
        }
    }
    @objc private func mediaReset(_ n: Notification) { q.async { self.playWired = false; self.micEng = nil; self.restartAudio() } }

    // 能不能一边念一边听用户说话（2026-10-23，用户要说话打断小芽 / 小智）：喇叭的声音进了麦克风，服务器分不清是人还是回声，所以只有
    // ① 系统给麦克风开了回声消除（iOS 18.2+ 的 setPrefersEchoCancelledInput，只在通话里要，跟播放、麦克风引擎不绑定，不改变声音），或者
    // ② 声音走的是耳机 / 蓝牙（喇叭不对着麦克风）时，才告诉网页「可以」，网页再告诉服务器（op call_cfg）。老系统、外放又没有回声消除就是 false，行为跟以前一样
    private(set) var echoSafe = false

    private func echoOk() -> Bool {
        let s = AVAudioSession.sharedInstance()
        if #available(iOS 18.2, *), s.isEchoCancelledInputEnabled { return true }
        let quiet: [AVAudioSession.Port] = [.headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .usbAudio, .carAudio]
        return s.currentRoute.outputs.contains { quiet.contains($0.portType) }
    }

    private func recheckEcho() {                    // 在 q 上调：变了就告诉网页
        guard liveOn else { return }
        let ok = echoOk()
        if ok != echoSafe { echoSafe = ok; emit?("aec", ["on": ok]) }
    }

    @objc private func routeChanged(_ n: Notification) { q.async { self.recheckEcho() } }

    private func restartAudio() {
        if speaking || keeping { _ = ensurePlay(); if keeping { keeper.play() } }
        if liveOn || pttOn {
            closeMicEngine()
            _ = openMic()
        }
    }

    // ---------------------------------------------------------------- 麦克风：按住说话 ptt、小芽常开收音 live 共用一路，预录 0.5 秒
    private(set) var liveOn = false
    private(set) var liveMuted = false
    private var pttOn = false
    private var pttEnc = Adpcm(), liveEnc = Adpcm()
    private var sttPtt = SttRing(), sttLive = SttRing()          // 送给服务器的上行音频原样留一份，系统识别按服务器说的位置取
    private lazy var speech = SysSpeech(self.q)

    // 服务器要手机识别自己录下的一段（server.py 的 asr_any）
    private func sttRequest(_ m: [String: Any]) {
        let id = m["i"] as? Int ?? 0
        func reply(_ o: [String: Any]) {
            if let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) { send(s) }
        }
        let ring = (m["s"] as? String) == "live" ? sttLive : sttPtt
        guard let pcm = ring.slice(m["a"] as? Int ?? 0, m["b"] as? Int ?? 0) else {
            return reply(["t": "stt", "i": id, "err": "这段录音已经不在手机上了"])
        }
        speech.run(pcm, ctx: m["ctx"] as? [String] ?? []) { text, err, deny in
            var o: [String: Any] = ["t": "stt", "i": id]
            if let text = text { o["text"] = text } else { o["err"] = err ?? "识别失败"; if deny { o["deny"] = true } }
            reply(o)
        }
    }
    private var ring = [[Int16]]()
    private var acc: Float = 0, accN = 0, pos: Double = 0
    private var frame = [Int16]()
    private var lvBuf = [Double]()
    private var micIdle: DispatchWorkItem?

    static func micPermission(_ done: @escaping (Bool) -> Void) {
        let s = AVAudioSession.sharedInstance()
        switch s.recordPermission {
        case .granted: SysSpeech.askPermission(); done(true)
        case .denied: done(false)
        default: s.requestRecordPermission { ok in if ok { SysSpeech.askPermission() }; done(ok) }
        }
    }

    private func openMic() -> String? {
        micIdle?.cancel()
        if micEng != nil { return nil }
        audioSession()
        let e = AVAudioEngine()
        let input = e.inputNode
        let f = input.outputFormat(forBus: 0)
        guard f.sampleRate > 0, f.channelCount > 0 else { return "麦克风打不开（没有输入）" }
        let ratio = f.sampleRate / 16000
        acc = 0; accN = 0; pos = 0; frame.removeAll()
        input.installTap(onBus: 0, bufferSize: 2048, format: f) { [weak self] buf, _ in
            guard let self = self, let ch = buf.floatChannelData?[0] else { return }
            let n = Int(buf.frameLength)
            var out = [Int16]()
            out.reserveCapacity(n / Int(max(1, ratio)) + 2)
            // 降到 16k：按比例把几个点平均成一个（顺带低通），跟网页版一样
            var a = self.acc, an = self.accN, p = self.pos
            for i in 0..<n {
                a += ch[i]; an += 1; p += 1
                if p >= ratio {
                    p -= ratio
                    out.append(Int16(max(-32768, min(32767, (a / Float(an)) * 32768))))
                    a = 0; an = 0
                }
            }
            self.acc = a; self.accN = an; self.pos = p
            self.q.async { self.onPcm(out) }
        }
        e.prepare()
        do { try e.start() } catch { input.removeTap(onBus: 0); return "麦克风打不开：\(error.localizedDescription)" }
        micEng = e
        return nil
    }

    private func closeMicEngine() {
        micEng?.inputNode.removeTap(onBus: 0)
        micEng?.stop()
        micEng = nil
    }

    private func closeMic() {
        closeMicEngine()
        ring.removeAll()
        frame.removeAll()
    }

    private func micMaybeIdle() {               // 没在录也没在通话：20 秒后关麦（不然顶上一直亮着橙点）
        micIdle?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, !self.pttOn, !self.liveOn else { return }
            self.closeMic()
            self.updateBg()
        }
        micIdle = w
        q.asyncAfter(deadline: .now() + 20, execute: w)
    }

    private func onPcm(_ p: [Int16]) {
        frame.append(contentsOf: p)
        while frame.count >= 320 {                // 20ms 一帧
            let fr = Array(frame[0..<320])
            frame.removeFirst(320)
            var s: Double = 0
            for x in fr { s += Double(x) * Double(x) }
            let db = 20 * log10(sqrt(s / 320) / 32768 + 1e-6)
            let v = max(0, min(1, (db + 58) / 46))
            if pttOn {
                pttEnc.feed(fr); sttPtt.add(fr); sendAu(&pttEnc, all: false)
            } else if liveOn {
                if !liveMuted { liveEnc.feed(fr); sttLive.add(fr); sendAu(&liveEnc, all: false) }
            } else {
                ring.append(fr)
                if ring.count > 25 { ring.removeFirst() }
            }
            if pttOn || liveOn {
                lvBuf.append(pttOn || !liveMuted ? v : 0)
                if lvBuf.count >= 3 { if fg { emit?("lv", ["v": lvBuf]) }; lvBuf.removeAll() }
            }
        }
    }

    private func sendAu(_ e: inout Adpcm, all: Bool) {
        if let b = e.take(all: all) { send("{\"t\":\"au\",\"d\":\"\(Data(b).base64EncodedString())\"}") }
    }

    func pttStart(_ msg: String) -> String? {
        if let err = openMic() { return err }
        pttEnc.reset(); sttPtt.reset()
        if !send(msg) { return "还没连上服务器" }
        pttOn = true
        for p in ring { pttEnc.feed(p); sttPtt.add(p) }
        ring.removeAll()
        sendAu(&pttEnc, all: false)
        beep("start")
        return nil
    }

    func pttStop(_ msg: String) {
        if pttOn { sendAu(&pttEnc, all: true) }
        pttOn = false
        if !msg.isEmpty { send(msg) }
        micMaybeIdle()
    }

    func liveStart(_ mute: Bool) -> String? {
        let changed = liveMuted != mute
        liveMuted = mute
        if liveOn { if changed { activityUpdate() }; return nil }
        if #available(iOS 18.2, *) { try? AVAudioSession.sharedInstance().setPrefersEchoCancelledInput(true) }
        if let err = openMic() { return err }
        echoSafe = echoOk()
        liveOn = true
        q.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.recheckEcho() }     // 回声消除是开麦后才生效的，等一下再看一次
        liveEnc.reset(); sttLive.reset()
        send("{\"t\":\"rec\",\"wc\":15}")
        beep("start")
        updateBg()
        laState = ""                                // 每通电话都报一次实时活动建没建起来
        activityUpdate()
        return nil
    }

    func liveStop(_ vs: Int) {
        guard liveOn else { return }
        liveOn = false
        echoSafe = false
        if #available(iOS 18.2, *) { try? AVAudioSession.sharedInstance().setPrefersEchoCancelledInput(false) }
        sendAu(&liveEnc, all: true)
        send(vs != 0 ? "{\"t\":\"rec_end\",\"vs\":\(vs)}" : "{\"t\":\"rec_cancel\"}")
        soundOff = false
        micMaybeIdle()
        updateBg()
        activityUpdate()
    }

    // ---------------------------------------------------------------- 朗读：p24（24k 16 位 PCM，不压缩）或 a16（16k ADPCM 解成 PCM）排进 AVAudioPlayerNode，音量 = 手机音量键
    private(set) var speaking = false
    private var spN = -1, spDec = Adpcm(), queued = 0, spGen = 0, waitStart = false, preDur: Double = 0, sp24 = false
    private var spNode: AVAudioPlayerNode { sp24 ? player24 : player }

    private func spStart(_ n: Int, _ fmt: String) {
        stopPlayer()
        if soundOff { spN = -1; send("{\"t\":\"sp_stop\"}"); return }   // 关着声音：让服务器别合成了（也别因为「在念」不听用户说话）
        guard fmt == "a16" || fmt == "p24", ensurePlay() else { spN = -1; return }
        sp24 = fmt == "p24"
        spN = n
        spDec.reset()
        waitStart = true                         // 先攒 0.25 秒再开播，网络抖一下不断
        preDur = 0
    }

    private func spData(_ n: Int, _ d: String) {
        guard n == spN, let b = Data(base64Encoded: d) else { return }
        if sp24 {                                // 不压缩：24k 单声道 16 位小端 PCM
            let k = b.count / 2
            guard k > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt24, frameCapacity: AVAudioFrameCount(k)), let ch = buf.floatChannelData?[0] else { return }
            b.withUnsafeBytes { raw in
                for i in 0..<k { ch[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768 }
            }
            buf.frameLength = AVAudioFrameCount(k)
            spPlay(buf, Double(k) / 24000)
            return
        }
        guard let buf = AVAudioPCMBuffer(pcmFormat: fmt16, frameCapacity: AVAudioFrameCount(b.count * 2)),
              let ch = buf.floatChannelData?[0] else { return }
        var j = 0
        for x in b {                             // 朗读 a16 高半字节在前（audioop）
            ch[j] = Float(spDec.dec(Int32(x >> 4))) / 32768; j += 1
            ch[j] = Float(spDec.dec(Int32(x & 15))) / 32768; j += 1
        }
        buf.frameLength = AVAudioFrameCount(j)
        spPlay(buf, Double(j) / 16000)
    }

    private func spPlay(_ buf: AVAudioPCMBuffer, _ dur: Double) {
        schedule(buf)
        preDur += dur
        if waitStart && preDur >= 0.25 { waitStart = false; spNode.play() }
        setSpeaking(true)
    }

    private func schedule(_ buf: AVAudioPCMBuffer) {
        queued += 1
        let g = spGen
        spNode.scheduleBuffer(buf) { [weak self] in
            self?.q.async {
                guard let self = self, g == self.spGen else { return }
                self.queued -= 1
                if self.queued <= 0 { self.queued = 0; self.q.asyncAfter(deadline: .now() + 0.3) { if self.queued == 0 && g == self.spGen { self.setSpeaking(false) } } }
            }
        }
    }

    private func setSpeaking(_ on: Bool) {
        guard speaking != on else { return }
        speaking = on
        emit?("sp", ["on": on])
        updateBg()
        if liveOn { activityUpdate() }
    }

    private func stopPlayer() {
        spGen += 1
        queued = 0
        waitStart = false
        if playWired { player.stop(); player24.stop() }
    }

    func spStop(tell: Bool) {
        let was = speaking
        spN = -1
        stopPlayer()
        setSpeaking(false)
        if tell && was { send("{\"t\":\"sp_stop\"}") }
    }

    func beep(_ k: String) {
        guard !soundOff, ensurePlay() else { return }
        let tones: [(Double, Int)] = k == "err" ? [(220, 250)] : k == "start" ? [(660, 90), (990, 150)] : [(880, 80), (1320, 120)]
        let total = tones.reduce(0) { $0 + ($1.1 + 40) * 16 }
        guard let buf = AVAudioPCMBuffer(pcmFormat: fmt16, frameCapacity: AVAudioFrameCount(total)), let ch = buf.floatChannelData?[0] else { return }
        var j = 0
        for (f, ms) in tones {
            let n = ms * 16
            for i in 0..<n {
                let env = min(1, Double(min(i, n - i)) / 80)
                ch[j] = Float(sin(2 * Double.pi * f * Double(i) / 16000) * 0.15 * env); j += 1
            }
            for _ in 0..<(40 * 16) { ch[j] = 0; j += 1 }
        }
        buf.frameLength = AVAudioFrameCount(j)
        if !speaking && spN < 0 { stopPlayer() }
        player.scheduleBuffer(buf, completionHandler: nil)
        player.play()
    }

    // ---------------------------------------------------------------- 后台：通话时麦克风本身让 App 留在后台；Claude 干活时放静音保活；结果弹本地通知
    private var keeping = false
    private var bgTask: UIBackgroundTaskIdentifier = .invalid

    func setBg(keep k: Bool, notify n: Bool, busy b: Bool) {
        keep = k; notify = n; busy = b
        updateBg()
    }

    private func updateBg() {
        let need = keep && want && busy && !liveOn             // 通话中麦克风开着，本来就不会被挂起；在前台就先放上，切后台时已经在响
        if need && !keeping {
            guard ensurePlay(), let buf = AVAudioPCMBuffer(pcmFormat: fmt16, frameCapacity: 16000) else { return }
            buf.frameLength = 16000                             // 一秒静音循环放
            keeper.scheduleBuffer(buf, at: nil, options: .loops, completionHandler: nil)
            keeper.play()
            keeping = true
        } else if !need && keeping {
            keeper.stop()
            keeping = false
        }
        // 切后台那一下先要几秒，静音 / 麦克风接上之前别被挂起
        DispatchQueue.main.async {
            if !self.fg && self.bgTask == .invalid {
                self.bgTask = UIApplication.shared.beginBackgroundTask { [weak self] in
                    guard let self = self else { return }
                    UIApplication.shared.endBackgroundTask(self.bgTask); self.bgTask = .invalid
                }
            } else if self.fg && self.bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(self.bgTask); self.bgTask = .invalid
            }
        }
    }

    static func notePermission() {
        UNUserNotificationCenter.current().getNotificationSettings { s in
            if s.authorizationStatus == .notDetermined {
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
            }
        }
    }

    // 定时提醒（2026-10-15）：App 在后台半分钟就被 iOS 冻结、连接断了，服务器到点送的提醒进不来（用户「提醒吃饭」就这么丢的），
    // 没有付费开发者账号又用不了远程推送。所以服务器把接下来 7 天要响的时刻推过来（alarms{now, list:[{id, at, name}]}），
    // 这里提前预约系统通知，到点 iOS 自己弹，App 冻结、关掉都照弹。每次收到整批换掉；关了「通知」就全撤掉。
    private var alarmAt: [String: [Double]] = [:]          // 任务号 → 预约的时刻（本机时间）：服务器实时送到的那条 note 据此判断是不是已经弹过

    private func alarms(_ m: [String: Any]) {
        let list = m["list"] as? [[String: Any]] ?? [], on = notify
        let now = Date().timeIntervalSince1970
        let skew = now - ((m["now"] as? Double) ?? now)     // 本机时钟比服务器快多少：按「还有几秒」预约，不怕两边时钟不准
        if on { LinkEngine.notePermission() }
        let c = UNUserNotificationCenter.current()
        c.getPendingNotificationRequests { reqs in
            c.removePendingNotificationRequests(withIdentifiers: reqs.map { $0.identifier }.filter { $0.hasPrefix("alarm-") })
            var at: [String: [Double]] = [:]
            for a in (on ? Array(list.prefix(60)) : []) {
                guard let id = a["id"] as? String, let t = (a["at"] as? NSNumber)?.doubleValue else { continue }
                let local = t + skew, wait = local - Date().timeIntervalSince1970
                guard wait > 1 else { continue }
                let n = UNMutableNotificationContent()
                n.title = "⏰ " + ((a["name"] as? String) ?? "定时提醒")
                n.body = "小芽的定时提醒"
                n.sound = .default
                n.threadIdentifier = "cron"
                c.add(UNNotificationRequest(identifier: "alarm-\(id)-\(Int(t))", content: n,
                                            trigger: UNTimeIntervalNotificationTrigger(timeInterval: wait, repeats: false)), withCompletionHandler: nil)
                at[id, default: []].append(local)
            }
            self.q.async { self.alarmAt = at }
        }
    }

    private func note(_ m: [String: Any]) {
        if (m["k"] as? String) == "xy" && liveOn {
            liveText = m["body"] as? String ?? ""
            activityUpdate()
        }
        let k = m["k"] as? String ?? "", job = m["job"] as? String
        guard notify, !fg || k == "cron" else { return }          // 定时提醒在前台也发（上面 willPresent 弹横幅），别的只在后台发
        let now = Date().timeIntervalSince1970
        if k == "cron", let job = job, (alarmAt[job] ?? []).contains(where: { abs($0 - now) < 600 }) { return }   // 预约的系统通知已经弹过这条了
        let c = UNMutableNotificationContent()
        c.title = m["title"] as? String ?? ""
        c.body = m["body"] as? String ?? ""
        if k != "xy" { c.sound = .default }       // 小芽一句句来，别每句都响
        c.threadIdentifier = k
        let r = UNNotificationRequest(identifier: "esplink-" + k + (job.map { "-" + $0 } ?? ""), content: c, trigger: nil)   // 同一类换掉上一条（定时提醒按任务分开）
        UNUserNotificationCenter.current().add(r, withCompletionHandler: nil)
    }
}
