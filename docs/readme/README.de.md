<!-- Translation of README.md as of 2026-11-24. Machine-translated; not yet reviewed by a native speaker. -->
<p align="center"><b>Deine Musik gehört dir</b></p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.zh.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <b>Deutsch</b> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.pl.md">Polski</a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/">
    <img src="../designs/readme-hero.png" alt="mStream-Webplayer und mobile App" width="830" />
  </a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/"><b>▶ Live-Demo ausprobieren</b></a> ·
  <a href="https://discord.gg/AM896Rr">Tritt unserem Discord bei</a> ·
  <a href="https://mstream.io/"><b>Website</b></a>
</p>


## mStream Server installieren

#### Docker [![Docker Pulls](https://img.shields.io/docker/pulls/linuxserver/mstream)](https://hub.docker.com/r/linuxserver/mstream)

Probiere es mit dem folgenden Befehl aus.

```shell
docker run -d --name=mstream -p 3000:3000 \
  -v /path/to/config:/config -v /path/to/music:/music \
  lscr.io/linuxserver/mstream:latest
```

[Auf dieser Seite steht, wie du mStream mit Docker Compose einrichtest](https://github.com/linuxserver/docker-mstream#usage)

#### Binärdateien zum Download

Installer und portable Binärdateien sind [für macOS, Windows und Linux verfügbar](https://mstream.io/server). Diese Binär-Builds bieten einige zusätzliche Funktionen, die es in der Docker-Version nicht gibt:

* Automatische Updates
* Audiowiedergabe direkt auf dem Server
* Eine grafische Oberfläche für die Einrichtung

#### CLI-Skripte

Diese Skripte installieren die Binärversionen von mStream über die Kommandozeile

```shell
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.ps1 | iex
```

## Mobile Clients

[<img src="../../webapp/assets/img/play-store-logo.png" alt="mStream bei Google Play" width="200" />](https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1)[<img src="../../webapp/assets/img/app-store-logo.png" alt="mStream im App Store" width="200" />](https://apps.apple.com/gb/app/mstream-music/id1455309629)

Diese Apps sind [Open Source](https://github.com/IrosTheBeggar/mstream_music). Wir bieten die [APK-Dateien zum Sideloading](https://github.com/IrosTheBeggar/mstream_music/releases/latest) an. Die APK-Builds enthalten einige zusätzliche Funktionen, die in den Play-Store-Builds nicht veröffentlicht werden können. Dazu gehören: Unterstützung für selbstsignierte Zertifikate, Funktionen zur Dateisicherung und die yt-dlp-Integration.

Außerdem erhältlich: [mStream Player von Niera Tech](https://mplayer.nieratech.com/) für [iOS](https://apps.apple.com/us/app/mstream-player/id1605378892) und [Android](https://play.google.com/store/apps/details?id=com.nieratechinc.mstreamplayer&hl=en_US).

## Desktop-Client

| Plattform | Download |
|---|---|
| Windows x64 | [mstream-player-desktop-win32-x64.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-win32-x64.zip) |
| macOS Apple Silicon | [mstream-player-desktop-darwin-arm64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-arm64.app.zip) |
| macOS Intel | [mstream-player-desktop-darwin-x64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-x64.app.zip) |
| Linux x64 | [mstream-player-desktop-linux-x64.tar.gz](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-linux-x64.tar.gz) |

Die Desktop-App ist [Open Source](https://github.com/IrosTheBeggar/mstream-terminal-player)

## MP3-Player

Demnächst verfügbar!


## Einzigartige Funktionen

* **Schnellverbindung (Quick Connect) über Iroh** - Verbinde Server und Clients, ohne Portweiterleitung, SSL-Zertifikate, DNS usw. einzurichten.
* **P2P-Musikempfehlungen** - Basiert auf dem Netzwerkprotokoll Iroh Gossip. Erhalte Musikempfehlungen von anderen mStream-Nutzern.
* **Föderation** - mehrere mStream-Server miteinander verbinden
* **Auto DJ** - endlose Playlists, die Musik von jedem Server in einem föderierten Netzwerk einbeziehen können. Nutzt das lokale Deep-Learning-KI-Modell Discogs effNet, um ähnlich klingende Titel zu finden.


## Weitere Funktionen

**Hören**

* Der Server ist ressourcenschonend und läuft auch auf leistungsschwächeren Systemen wie einem Raspberry Pi
* Transkodierung für langsame Verbindungen
* Jukebox-Modus: die Wiedergabe eines Browsers fernsteuern
* DLNA-Unterstützung
* Automatische Suche nach Albumcovern
* Automatische Backups auf jedes Laufwerk, das an deinen Server angeschlossen ist
* Integration von Torrent-Clients und Downloads mit yt-dlp

## Danksagungen

mStream baut auf einigen großartigen Open-Source-Bibliotheken auf:

* [music-metadata](https://github.com/Borewit/music-metadata) - Der Metadaten-Parser des JS-Fallback-Scanners
* [Lofty](https://github.com/Serial-ATA/lofty-rs) - Audio-Tag-Leser, auf dem der Rust-Scanner basiert
* [Symphonia](https://github.com/pdeljanov/Symphonia) - Reiner Rust-Audiodecoder, mit dem beim Scannen Wellenform-Vorschauen erzeugt werden
* [Butterchurn](https://github.com/jberg/butterchurn) - Ein in JavaScript geschriebener Klon des Milkdrop-Visualizers
* [LRCLib](https://lrclib.net/) - Optionale Quelle für synchronisierte Songtexte

Und danke an das Team von [LinuxServer.io](https://www.linuxserver.io/) für die Pflege des Docker-Images!
