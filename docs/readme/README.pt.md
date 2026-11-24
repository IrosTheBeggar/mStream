<!-- Translation of README.md as of 2026-11-24. Machine-translated; not yet reviewed by a native speaker. -->
<p align="center"><b>Sua música é sua</b></p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.zh.md">中文</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <b>Português</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.pl.md">Polski</a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/">
    <img src="../designs/readme-hero.png" alt="Player web e aplicativo móvel do mStream" width="830" />
  </a>
</p>

<p align="center">
  <a href="https://demo.mstream.io/"><b>▶ Experimente a demo ao vivo</b></a> ·
  <a href="https://discord.gg/AM896Rr">Entre no nosso Discord</a> ·
  <a href="https://mstream.io/"><b>Site</b></a>
</p>


## Instalar o servidor mStream

#### Docker [![Docker Pulls](https://img.shields.io/docker/pulls/linuxserver/mstream)](https://hub.docker.com/r/linuxserver/mstream)

Experimente executando o comando a seguir.

```shell
docker run -d --name=mstream -p 3000:3000 \
  -v /path/to/config:/config -v /path/to/music:/music \
  lscr.io/linuxserver/mstream:latest
```

[Veja nesta página como configurar o mStream com Docker Compose](https://github.com/linuxserver/docker-mstream#usage)

#### Binários para download

Instaladores e binários portáteis estão [disponíveis para macOS, Windows e Linux](https://mstream.io/server). Essas versões binárias trazem alguns recursos extras que não existem na versão Docker:

* Atualizações automáticas
* Reprodução de áudio no servidor
* Uma interface gráfica para a configuração

#### Scripts de CLI

Estes scripts instalam as versões binárias do mStream pela linha de comando

```shell
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/IrosTheBeggar/mStream/master/install.ps1 | iex
```

## Clientes móveis

[<img src="../../webapp/assets/img/play-store-logo.png" alt="mStream no Google Play" width="200" />](https://play.google.com/store/apps/details?id=mstream.music&pcampaignid=MKT-Other-global-all-co-prtnr-py-PartBadge-Mar2515-1)[<img src="../../webapp/assets/img/app-store-logo.png" alt="mStream na App Store" width="200" />](https://apps.apple.com/gb/app/mstream-music/id1455309629)

Estes aplicativos são de [código aberto](https://github.com/IrosTheBeggar/mstream_music). Oferecemos os [arquivos APK para instalação manual](https://github.com/IrosTheBeggar/mstream_music/releases/latest). As versões APK trazem alguns recursos adicionais que não podem ser publicados nas versões da Play Store. Entre eles: suporte a certificados autoassinados, recursos de backup de arquivos e integração com o yt-dlp.

Também disponível: [mStream Player da Niera Tech](https://mplayer.nieratech.com/) para [iOS](https://apps.apple.com/us/app/mstream-player/id1605378892) e [Android](https://play.google.com/store/apps/details?id=com.nieratechinc.mstreamplayer&hl=en_US).

## Cliente para desktop

| Plataforma | Download |
|---|---|
| Windows x64 | [mstream-player-desktop-win32-x64.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-win32-x64.zip) |
| macOS Apple Silicon | [mstream-player-desktop-darwin-arm64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-arm64.app.zip) |
| macOS Intel | [mstream-player-desktop-darwin-x64.app.zip](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-darwin-x64.app.zip) |
| Linux x64 | [mstream-player-desktop-linux-x64.tar.gz](https://github.com/IrosTheBeggar/mstream-terminal-player/releases/latest/download/mstream-player-desktop-linux-x64.tar.gz) |

O aplicativo para desktop é de [código aberto](https://github.com/IrosTheBeggar/mstream-terminal-player)

## MP3 Player

Em breve!


## Recursos exclusivos

* **Conexão rápida (Quick Connect) via Iroh** - Conecte seu servidor e seus clientes sem configurar redirecionamento de portas, certificados SSL, DNS etc.
* **Recomendações musicais P2P** - Baseadas no protocolo de rede Iroh Gossip. Receba recomendações musicais de outros usuários do mStream.
* **Federação** - conecte vários servidores mStream entre si
* **Auto DJ** - playlists sem fim que podem trazer músicas de qualquer servidor de uma rede federada. Usa o modelo local de IA de aprendizado profundo Discogs effNet para encontrar faixas com som parecido.


## Mais recursos

**Ouvir**

* O servidor é leve e roda em sistemas de baixa potência, como um Raspberry Pi
* Transcodificação para conexões lentas
* Modo Jukebox: controle remotamente a reprodução de um navegador
* Suporte a DLNA
* Busca automática de capas de álbuns
* Backups automáticos em qualquer unidade conectada ao seu servidor
* Integração com cliente de torrent e downloads com yt-dlp

## Créditos

O mStream é construído sobre ótimas bibliotecas de código aberto:

* [music-metadata](https://github.com/Borewit/music-metadata) - O analisador de metadados usado pelo scanner JS de reserva
* [Lofty](https://github.com/Serial-ATA/lofty-rs) - Leitor de tags de áudio que alimenta o scanner em Rust
* [Symphonia](https://github.com/pdeljanov/Symphonia) - Decodificador de áudio em Rust puro usado para gerar prévias de forma de onda durante a varredura
* [Butterchurn](https://github.com/jberg/butterchurn) - Um clone do visualizador Milkdrop escrito em JavaScript
* [LRCLib](https://lrclib.net/) - Fonte opcional de letras sincronizadas

E obrigado ao grupo [LinuxServer.io](https://www.linuxserver.io/) por manter a imagem Docker!
