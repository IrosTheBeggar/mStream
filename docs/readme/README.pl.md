<!-- Translation of README.md as of 2026-11-24. Machine-translated; not yet reviewed by a native speaker. -->
<p align="center"><b>Twoja muzyka należy do ciebie</b></p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.zh.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.it.md">Italiano</a> ·
  <b>Polski</b>
</p>

<p align="center">
  <a href="https://demo.mstream.io/">
    <img src="../designs/readme-hero.png" alt="Odtwarzacz webowy i aplikacja mobilna mStream" width="830" />
  </a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/"><b>▶ Wypróbuj demo na żywo</b></a> ·
  <a href="https://discord.gg/AM896Rr">Dołącz do naszego Discorda</a> ·
  <a href="https://mstream.io/"><b>Strona internetowa</b></a>
</p>


## Instalacja serwera mStream

#### Docker

[![Docker Pulls](https://img.shields.io/docker/pulls/linuxserver/mstream)](https://hub.docker.com/r/linuxserver/mstream)

Wypróbuj go, uruchamiając poniższe polecenie.

```shell
docker run -d --name=mstream -p 3000:3000 \
  -v /path/to/config:/config -v /path/to/music:/music \
  lscr.io/linuxserver/mstream:latest
```

[Na tej stronie opisano konfigurację mStream z Docker Compose](https://github.com/linuxserver/docker-mstream#usage)

#### Pliki binarne do pobrania

Wersje binarne mają kilka dodatkowych funkcji, których nie ma w wersji Docker:

* Automatyczne aktualizacje
* Odtwarzanie dźwięku po stronie serwera
* Graficzny interfejs konfiguracji

| Platforma | Pobieranie |
|---|---|
| Windows x64 | [Instalator (`setup.exe`) lub przenośny `.zip`](https://github.com/IrosTheBeggar/mStream/releases/latest) |
| macOS (Apple Silicon i Intel) | [Instalator (`.pkg`) lub przenośny `.zip`](https://github.com/IrosTheBeggar/mStream/releases/latest) |
| Linux (x64 i arm64) | [`.deb`, `.rpm` lub przenośny `.zip`](https://github.com/IrosTheBeggar/mStream/releases/latest) |

Przyciski bezpośredniego pobierania aktualnej wersji znajdują się na [mstream.io/server](https://mstream.io/server).

#### Skrypty CLI

Te skrypty instalują wersje binarne mStream z wiersza poleceń

```shell
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.ps1 | iex
```

## Klienty mobilne

[<img src="../../webapp/assets/img/play-store-logo.png" alt="mStream w Google Play" width="200" />](https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1)[<img src="../../webapp/assets/img/app-store-logo.png" alt="mStream w App Store" width="200" />](https://apps.apple.com/gb/app/mstream-music/id1455309629)

Te aplikacje są [open source](https://github.com/IrosTheBeggar/mstream_music). Udostępniamy [pliki APK do samodzielnej instalacji](https://github.com/IrosTheBeggar/mstream_music/releases/latest). Wersje APK mają kilka dodatkowych funkcji, których nie można opublikować w wersjach ze Sklepu Play. Należą do nich: obsługa certyfikatów samopodpisanych, funkcje kopii zapasowej plików oraz integracja z yt-dlp.

Dostępny jest też [mStream Player od Niera Tech](https://mplayer.nieratech.com/) na [iOS](https://apps.apple.com/us/app/mstream-player/id1605378892) i [Androida](https://play.google.com/store/apps/details?id=com.nieratechinc.mstreamplayer&hl=en_US).

## Klient na komputer

| Platforma | Pobieranie |
|---|---|
| Windows x64 | [mstream-player-desktop-win32-x64.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-win32-x64.zip) |
| macOS Apple Silicon | [mstream-player-desktop-darwin-arm64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-arm64.app.zip) |
| macOS Intel | [mstream-player-desktop-darwin-x64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-x64.app.zip) |
| Linux x64 | [mstream-player-desktop-linux-x64.tar.gz](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-linux-x64.tar.gz) |

Aplikacja na komputer jest [open source](https://github.com/IrosTheBeggar/mstream-terminal-player)

## Odtwarzacz MP3

Już wkrótce!


## Unikalne funkcje

* **Szybkie połączenie (Quick Connect) przez Iroh** - Połącz serwer z klientami bez konfigurowania przekierowania portów, certyfikatów SSL, DNS itp.
* **Rekomendacje muzyczne P2P** - Oparte na protokole sieciowym Iroh Gossip. Otrzymuj rekomendacje muzyczne od innych użytkowników mStream.
* **Federacja** - połącz ze sobą wiele serwerów mStream
* **Auto DJ** - niekończące się playlisty, które mogą pobierać muzykę z dowolnego serwera w sfederowanej sieci. Wykorzystuje lokalny model AI głębokiego uczenia Discogs effNet, aby znajdować podobnie brzmiące utwory.


## Więcej funkcji

**Słuchaj**

* Serwer jest lekki i działa na słabszych urządzeniach, takich jak Raspberry Pi
* Transkodowanie dla wolnych połączeń
* Tryb Jukebox: zdalnie steruj odtwarzaniem w przeglądarce
* Obsługa DLNA
* Automatyczne wyszukiwanie okładek albumów
* Automatyczne kopie zapasowe na dowolny dysk podłączony do serwera
* Integracja z klientem torrent i pobieranie przez yt-dlp

## Podziękowania

mStream powstał w oparciu o kilka świetnych bibliotek open source:

* [music-metadata](https://github.com/Borewit/music-metadata) - Parser metadanych używany przez zapasowy skaner JS
* [Lofty](https://github.com/Serial-ATA/lofty-rs) - Czytnik tagów audio, na którym opiera się skaner w Rust
* [Symphonia](https://github.com/pdeljanov/Symphonia) - Dekoder audio napisany w całości w Rust, używany do generowania podglądów przebiegu fali podczas skanowania
* [Butterchurn](https://github.com/jberg/butterchurn) - Klon wizualizatora Milkdrop napisany w JavaScripcie
* [LRCLib](https://lrclib.net/) - Opcjonalne źródło zsynchronizowanych tekstów piosenek

Dziękujemy też grupie [LinuxServer.io](https://www.linuxserver.io/) za utrzymywanie obrazu Docker!
