# MyWiki Release 规范

MyWiki 的客户端更新提示读取 GitHub Releases 的 latest release。为了让内测用户下载时不混淆，每个正式版本只对应一个 tag 和一个 GitHub Release。

## 版本号

- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`src-tauri/tauri.macos.conf.json` 保持同一个版本号。
- Git tag 使用 `vMAJOR.MINOR.PATCH`，例如 `v0.1.1`。
- 内测预览版本使用 GitHub prerelease。正式客户端的 latest release 默认只会指向非 prerelease。

## Release 页面

每个 Release 建议包含：

- Windows NSIS 安装包：`MyWiki_<version>_x64-setup.exe`
- Windows MSI 安装包：`MyWiki_<version>_x64_en-US.msi`
- macOS DMG：`MyWiki_<version>_<arch>.dmg`
- macOS app zip：`MyWiki_macos_<arch>.app.zip`
- 校验文件：`SHA256SUMS-windows.txt`、`SHA256SUMS-macos.txt`

当前 MVP 的更新逻辑是提示新版本并打开下载页；未来若接入 Tauri 自动更新，需要额外发布签名后的 updater 包和 manifest。

## Windows 与 Apple 平台

Windows 可以直接分发 `.exe` 或 `.msi`。如果目标是苹果电脑客户端，请使用 macOS `.dmg` / `.app.zip`。

如果目标是真正的 iOS（iPhone / iPad），它不是普通安装包下载模式，需要独立的 iOS 构建、证书、provisioning profile，以及 TestFlight、App Store 或企业签名分发流程。这个链路应单独规划，不建议和桌面端安装包混在同一个“下载按钮”里。

## 发布流程

1. 确认版本号已同步。
2. 合并到 `main`。
3. 创建并推送 tag，例如 `git tag v0.1.1 && git push origin v0.1.1`。
4. GitHub Actions 会运行 `Release Packages`，生成 Windows 和 macOS 资产并创建 GitHub Release。
5. 发布完成后，用客户端“关于 / 版本更新”里的“立即检查”确认 latest release 能被本地客户端识别。
