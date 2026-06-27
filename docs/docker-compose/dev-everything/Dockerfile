FROM node:22-bookworm-slim

# libasound2 — runtime for the rust-server-audio binary (links cpal → ALSA)
# alsa-utils — `aplay -l` etc. for debugging device passthrough from inside the container
# mpv        — CLI-fallback player exercised by src/api/cli-audio/mpv.js
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libasound2 \
      alsa-utils \
      mpv \
 && rm -rf /var/lib/apt/lists/*
