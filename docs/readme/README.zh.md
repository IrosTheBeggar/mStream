<!-- Translation of README.md as of 2026-11-24. Machine-translated; not yet reviewed by a native speaker. -->
<p align="center"><b>你的音乐，由你做主</b></p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <b>中文</b> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.pl.md">Polski</a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/">
    <img src="../designs/readme-hero.png" alt="mStream 网页播放器和移动应用" width="830" />
  </a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/"><b>▶ 试用在线演示</b></a> ·
  <a href="https://discord.gg/AM896Rr">加入我们的 Discord</a> ·
  <a href="https://mstream.io/"><b>官方网站</b></a>
</p>


## 安装 mStream 服务器

#### Docker

[![Docker Pulls](https://img.shields.io/docker/pulls/linuxserver/mstream)](https://hub.docker.com/r/linuxserver/mstream)

运行以下命令即可试用。

```shell
docker run -d --name=mstream -p 3000:3000 \
  -v /path/to/config:/config -v /path/to/music:/music \
  lscr.io/linuxserver/mstream:latest
```

[使用 Docker Compose 部署 mStream 的方法请参阅此页面](https://github.com/linuxserver/docker-mstream#usage)

#### 二进制文件下载

二进制版本提供一些 Docker 版本没有的额外功能：

* 自动更新
* 服务器端音频播放
* 用于设置的图形界面

| 平台 | 下载 |
|---|---|
| Windows x64 | [安装程序 (`setup.exe`) 或便携版 `.zip`](https://github.com/IrosTheBeggar/mStream/releases/latest) |
| macOS（Apple 芯片和 Intel） | [安装程序 (`.pkg`) 或便携版 `.zip`](https://github.com/IrosTheBeggar/mStream/releases/latest) |
| Linux（x64 和 arm64） | [`.deb`、`.rpm` 或便携版 `.zip`](https://github.com/IrosTheBeggar/mStream/releases/latest) |

当前版本的直接下载按钮位于 [mstream.io/server](https://mstream.io/server)。

#### 命令行脚本

这些脚本通过命令行安装 mStream 的二进制版本

```shell
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.ps1 | iex
```

## 移动客户端

[<img src="../../webapp/assets/img/play-store-logo.png" alt="在 Google Play 获取 mStream" width="200" />](https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1)[<img src="../../webapp/assets/img/app-store-logo.png" alt="在 App Store 获取 mStream" width="200" />](https://apps.apple.com/gb/app/mstream-music/id1455309629)

这些应用是[开源的](https://github.com/IrosTheBeggar/mstream_music)。我们还提供[可供侧载的 APK 文件](https://github.com/IrosTheBeggar/mstream_music/releases/latest)。APK 版本包含一些无法在 Play 商店版本中发布的额外功能，包括：支持自签名证书、文件备份功能以及 yt-dlp 集成。

另外还有 [Niera Tech 开发的 mStream Player](https://mplayer.nieratech.com/)，支持 [iOS](https://apps.apple.com/us/app/mstream-player/id1605378892) 和 [Android](https://play.google.com/store/apps/details?id=com.nieratechinc.mstreamplayer&hl=en_US)。

## 桌面客户端

| 平台 | 下载 |
|---|---|
| Windows x64 | [mstream-player-desktop-win32-x64.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-win32-x64.zip) |
| macOS Apple Silicon | [mstream-player-desktop-darwin-arm64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-arm64.app.zip) |
| macOS Intel | [mstream-player-desktop-darwin-x64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-x64.app.zip) |
| Linux x64 | [mstream-player-desktop-linux-x64.tar.gz](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-linux-x64.tar.gz) |

桌面应用是[开源的](https://github.com/IrosTheBeggar/mstream-terminal-player)

## MP3 播放器

即将推出！


## 独特功能

* **基于 Iroh 的快速连接 (Quick Connect)** - 无需配置端口转发、SSL 证书、DNS 等，即可连接服务器和客户端。
* **P2P 音乐推荐** - 基于 Iroh Gossip 网络协议构建。获取其他 mStream 用户的音乐推荐。
* **联合 (Federation)** - 将多个 mStream 服务器连接在一起
* **Auto DJ** - 无限播放列表，可以从联合网络中的任意服务器获取音乐。它使用本地运行的 Discogs effNet 深度学习 AI 模型来寻找听起来相似的曲目。


## 更多功能

**聆听**

* 服务器非常轻量，可以在树莓派 (Raspberry Pi) 这类低功耗设备上运行
* 针对慢速连接的转码
* 点唱机模式：远程控制浏览器的播放
* 支持 DLNA
* 自动查找专辑封面
* 自动备份到连接至服务器的任意驱动器
* Torrent 客户端集成与 yt-dlp 下载

## 致谢

mStream 构建于一些优秀的开源库之上：

* [music-metadata](https://github.com/Borewit/music-metadata) - 备用 JS 扫描器使用的元数据解析器
* [Lofty](https://github.com/Serial-ATA/lofty-rs) - 为 Rust 扫描器提供支持的音频标签读取库
* [Symphonia](https://github.com/pdeljanov/Symphonia) - 纯 Rust 实现的音频解码器，用于在扫描时生成波形预览
* [Butterchurn](https://github.com/jberg/butterchurn) - 用 JavaScript 编写的 Milkdrop 可视化效果克隆版
* [LRCLib](https://lrclib.net/) - 可选的同步歌词来源

同时感谢 [LinuxServer.io](https://www.linuxserver.io/) 团队维护 Docker 镜像！
