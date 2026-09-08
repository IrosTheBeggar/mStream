# Docker image for routing-smoke-testing the CLI audio adapters.
# Installs mpv, vlc (via cvlc), and mplayer, plus ffmpeg to pre-generate a
# short test tone. Headless containers have no audio device, so we shadow
# each binary with a wrapper in /usr/local/bin that forces a null audio
# output — this lets the players run end-to-end without erroring out on
# missing ALSA/PulseAudio.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      mpv \
      vlc-bin \
      vlc-plugin-base \
      mplayer \
      mpd \
      ffmpeg \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Shadow each binary with a wrapper that prepends null-audio flags.
# /usr/local/bin comes before /usr/bin in PATH, so `spawn('mpv', …)` hits
# the wrapper first. The wrapper invokes the real binary by absolute path
# to avoid recursion.
RUN { echo '#!/bin/sh'; echo 'exec /usr/bin/mpv --ao=null "$@"'; } > /usr/local/bin/mpv \
 && { echo '#!/bin/sh'; echo 'exec /usr/bin/vlc --aout=dummy "$@"'; } > /usr/local/bin/vlc \
 && { echo '#!/bin/sh'; echo 'exec /usr/bin/mplayer -ao null "$@"'; } > /usr/local/bin/mplayer \
 && chmod +x /usr/local/bin/mpv /usr/local/bin/vlc /usr/local/bin/mplayer

# VLC refuses to run as root, so set up an unprivileged user for the test.
RUN useradd -m -u 1001 -s /bin/bash tester

WORKDIR /app

# Minimal dependency install — our adapters only need winston.
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund winston >/dev/null

COPY src/state/cli-audio ./src/state/cli-audio
# base.js and mplayer.js import WebError from src/util; the image carries
# only what is COPYed here, so without this line the harness dies at import.
COPY src/util/web-error.js ./src/util/web-error.js
COPY test/cli-audio/test-routing.mjs ./test/cli-audio/test-routing.mjs
COPY test/cli-audio/mpd.conf        ./test/cli-audio/mpd.conf
COPY test/cli-audio/entrypoint.sh   ./test/cli-audio/entrypoint.sh

# Pre-generate a short sine-wave MP3 that all four players can decode.
RUN ffmpeg -y -f lavfi -i "sine=frequency=440:duration=10" -ac 2 -ar 44100 \
      -c:a libmp3lame -q:a 5 /tmp/test-tone.mp3 \
 && chmod +x /app/test/cli-audio/entrypoint.sh \
 && chown -R tester:tester /app /tmp/test-tone.mp3

USER tester
ENV HOME=/home/tester

CMD ["/app/test/cli-audio/entrypoint.sh"]
