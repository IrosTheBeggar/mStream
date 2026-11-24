<!-- Translation of README.md as of 2026-11-24. Machine-translated; not yet reviewed by a native speaker. -->
<p align="center">
  <img src="../../webapp/assets/img/mstream-logo.png" alt="mStream" width="320" />
</p>

<p align="center"><b>Tu música es tuya</b></p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <b>Español</b> ·
  <a href="README.zh.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.pl.md">Polski</a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/"><b>▶ Prueba la demo en vivo</b></a>
  <a href="https://discord.gg/AM896Rr"><img src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://mstream.io/"><b>Sitio web</b></a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/">
    <img src="../designs/readme-hero.png" alt="Reproductor web y aplicación móvil de mStream" width="830" />
  </a>
</p>


## Instalar el servidor mStream

**Docker**

[![Docker Pulls](https://img.shields.io/docker/pulls/linuxserver/mstream)](https://hub.docker.com/r/linuxserver/mstream)

Pruébalo ejecutando el siguiente comando.

```shell
docker run -d --name=mstream -p 3000:3000 \
  -v /path/to/config:/config -v /path/to/music:/music \
  lscr.io/linuxserver/mstream:latest
```

[Consulta esta página para configurar mStream con Docker Compose](https://github.com/linuxserver/docker-mstream#usage)

**Binarios para descargar**

Hay instaladores y binarios portables [disponibles para macOS, Windows y Linux](https://mstream.io/server). Estas versiones binarias incluyen algunas funciones adicionales que no están disponibles en la versión de Docker:

* Actualizaciones automáticas
* Reproducción de audio en el servidor
* Una interfaz gráfica para la configuración

**Scripts de CLI**

Estos scripts instalan las versiones binarias de mStream desde la línea de comandos

```shell
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.ps1 | iex
```

## Clientes móviles

[<img src="../../webapp/assets/img/play-store-logo.png" alt="mStream en Google Play" width="200" />](https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1)[<img src="../../webapp/assets/img/app-store-logo.png" alt="mStream en el App Store" width="200" />](https://apps.apple.com/gb/app/mstream-music/id1455309629)

Estas aplicaciones son de [código abierto](https://github.com/IrosTheBeggar/mstream_music). Ofrecemos los [archivos APK para instalación manual](https://github.com/IrosTheBeggar/mstream_music/releases/latest). Las versiones APK incluyen algunas funciones adicionales que no se pueden publicar en las versiones de Play Store. Entre ellas: compatibilidad con certificados autofirmados, funciones de copia de seguridad de archivos e integración con yt-dlp.

También disponible: [mStream Player de Niera Tech](https://mplayer.nieratech.com/) para [iOS](https://apps.apple.com/us/app/mstream-player/id1605378892) y [Android](https://play.google.com/store/apps/details?id=com.nieratechinc.mstreamplayer&hl=en_US).

## Cliente de escritorio

| Plataforma | Descarga |
|---|---|
| Windows x64 | [mstream-player-desktop-win32-x64.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-win32-x64.zip) |
| macOS Apple Silicon | [mstream-player-desktop-darwin-arm64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-arm64.app.zip) |
| macOS Intel | [mstream-player-desktop-darwin-x64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-x64.app.zip) |
| Linux x64 | [mstream-player-desktop-linux-x64.tar.gz](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-linux-x64.tar.gz) |

La aplicación de escritorio es de [código abierto](https://github.com/IrosTheBeggar/mstream-terminal-player)

## Reproductor MP3

¡Próximamente!


## Funciones únicas

* **Conexión rápida (Quick Connect) mediante Iroh** - Conecta tu servidor y tus clientes sin configurar redirección de puertos, certificados SSL, DNS, etc.
* **Recomendaciones musicales P2P** - Basadas en el protocolo de red Iroh Gossip. Recibe recomendaciones musicales de otros usuarios de mStream.
* **Federación** - conecta varios servidores mStream entre sí
* **Auto DJ** - listas de reproducción infinitas que pueden incorporar música de cualquier servidor de una red federada. Utiliza el modelo local de IA de aprendizaje profundo Discogs effNet para encontrar pistas que suenan parecido.


## Más funciones

**Escuchar**

* El servidor es ligero y funciona en sistemas de baja potencia como una Raspberry Pi
* Transcodificación para conexiones lentas
* Modo Jukebox: controla de forma remota la reproducción de un navegador
* Compatibilidad con DLNA
* Búsqueda automática de carátulas de álbumes
* Copias de seguridad automáticas en cualquier unidad conectada a tu servidor
* Integración con clientes de torrent y descargas con yt-dlp

## Créditos

mStream está construido sobre excelentes bibliotecas de código abierto:

* [music-metadata](https://github.com/Borewit/music-metadata) - El analizador de metadatos que usa el escáner JS de respaldo
* [Lofty](https://github.com/Serial-ATA/lofty-rs) - Lector de etiquetas de audio en el que se basa el escáner de Rust
* [Symphonia](https://github.com/pdeljanov/Symphonia) - Decodificador de audio escrito íntegramente en Rust que se usa para generar vistas previas de forma de onda durante el escaneo
* [Butterchurn](https://github.com/jberg/butterchurn) - Un clon del visualizador Milkdrop escrito en JavaScript
* [LRCLib](https://lrclib.net/) - Fuente opcional de letras sincronizadas

¡Y gracias al grupo [LinuxServer.io](https://www.linuxserver.io/) por mantener la imagen de Docker!
