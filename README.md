# 小芽 App

Capacitor 做的手机 App（iOS / Android 共用 `www/` 界面）。本仓库是用来云编的公开镜像：服务器地址和令牌不在源码里，登录时填 / 发版时才写进安装包。

- 界面：`www/`（普通 JS，无打包器）
- iOS 原生：`ios/`（通话链路、实时活动小组件）
- 云编：`.github/workflows/ios.yml`（未签名 IPA）

## 第三方
Capacitor（MIT）、@capgo/capacitor-inappbrowser（MPL-2.0）等，见 `package.json`。
