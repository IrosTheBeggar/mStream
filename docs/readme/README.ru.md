<!-- Translation of README.md as of 2026-11-24. Machine-translated; not yet reviewed by a native speaker. -->
<p align="center"><b>Ваша музыка принадлежит вам</b></p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.zh.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ja.md">日本語</a> ·
  <b>Русский</b> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.pl.md">Polski</a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/">
    <img src="../designs/readme-hero.png" alt="Веб-плеер и мобильное приложение mStream" width="830" />
  </a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/"><b>▶ Попробовать демо</b></a> ·
  <a href="https://discord.gg/AM896Rr">Присоединяйтесь к нашему Discord</a> ·
  <a href="https://mstream.io/"><b>Сайт</b></a>
</p>


## Установка сервера mStream

#### Docker [![Docker Pulls](https://img.shields.io/docker/pulls/linuxserver/mstream)](https://hub.docker.com/r/linuxserver/mstream)

Попробуйте, выполнив следующую команду.

```shell
docker run -d --name=mstream -p 3000:3000 \
  -v /path/to/config:/config -v /path/to/music:/music \
  lscr.io/linuxserver/mstream:latest
```

[На этой странице описана настройка mStream через Docker Compose](https://github.com/linuxserver/docker-mstream#usage)

#### Бинарные сборки для скачивания

Установщики и портативные сборки [доступны для macOS, Windows и Linux](https://mstream.io/server). В бинарных сборках есть несколько дополнительных возможностей, которых нет в версии для Docker:

* Автоматические обновления
* Воспроизведение звука на стороне сервера
* Графический интерфейс для настройки

#### CLI-скрипты

Эти скрипты устанавливают бинарные версии mStream из командной строки

```shell
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.ps1 | iex
```

## Мобильные клиенты

[<img src="../../webapp/assets/img/play-store-logo.png" alt="mStream в Google Play" width="200" />](https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1)[<img src="../../webapp/assets/img/app-store-logo.png" alt="mStream в App Store" width="200" />](https://apps.apple.com/gb/app/mstream-music/id1455309629)

Эти приложения имеют [открытый исходный код](https://github.com/IrosTheBeggar/mstream_music). Мы предлагаем [APK-файлы для ручной установки](https://github.com/IrosTheBeggar/mstream_music/releases/latest). В APK-сборках есть дополнительные возможности, которые нельзя выпустить в сборках для Play Маркета. Среди них: поддержка самоподписанных сертификатов, резервное копирование файлов и интеграция с yt-dlp.

Также доступен [mStream Player от Niera Tech](https://mplayer.nieratech.com/) для [iOS](https://apps.apple.com/us/app/mstream-player/id1605378892) и [Android](https://play.google.com/store/apps/details?id=com.nieratechinc.mstreamplayer&hl=en_US).

## Клиент для компьютера

| Платформа | Скачать |
|---|---|
| Windows x64 | [mstream-player-desktop-win32-x64.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-win32-x64.zip) |
| macOS Apple Silicon | [mstream-player-desktop-darwin-arm64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-arm64.app.zip) |
| macOS Intel | [mstream-player-desktop-darwin-x64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-x64.app.zip) |
| Linux x64 | [mstream-player-desktop-linux-x64.tar.gz](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-linux-x64.tar.gz) |

Приложение для компьютера имеет [открытый исходный код](https://github.com/IrosTheBeggar/mstream-terminal-player)

## MP3-плеер

Скоро!


## Уникальные возможности

* **Быстрое подключение (Quick Connect) через Iroh** - Подключайте клиенты к серверу без настройки проброса портов, SSL-сертификатов, DNS и т. д.
* **Музыкальные рекомендации P2P** - Работают на сетевом протоколе Iroh Gossip. Получайте музыкальные рекомендации от других пользователей mStream.
* **Федерация** - объединяйте несколько серверов mStream
* **Авто-DJ** - бесконечные плейлисты, в которые может попадать музыка с любого сервера федеративной сети. Использует локальную ИИ-модель глубокого обучения Discogs effNet, чтобы находить похожие по звучанию треки.


## Другие возможности

**Слушать**

* Сервер нетребователен к ресурсам и работает на маломощных системах вроде Raspberry Pi
* Транскодирование для медленных соединений
* Режим музыкального автомата: удалённое управление воспроизведением в браузере
* Поддержка DLNA
* Автоматический поиск обложек альбомов
* Автоматическое резервное копирование на любой диск, подключённый к серверу
* Интеграция с торрент-клиентом и загрузки через yt-dlp

## Благодарности

mStream построен на основе нескольких отличных библиотек с открытым исходным кодом:

* [music-metadata](https://github.com/Borewit/music-metadata) - Парсер метаданных, используемый резервным JS-сканером
* [Lofty](https://github.com/Serial-ATA/lofty-rs) - Библиотека чтения аудиотегов, на которой работает Rust-сканер
* [Symphonia](https://github.com/pdeljanov/Symphonia) - Аудиодекодер на чистом Rust, используемый для построения превью формы волны во время сканирования
* [Butterchurn](https://github.com/jberg/butterchurn) - Клон визуализатора Milkdrop, написанный на JavaScript
* [LRCLib](https://lrclib.net/) - Необязательный источник синхронизированных текстов песен

И спасибо команде [LinuxServer.io](https://www.linuxserver.io/) за поддержку Docker-образа!
