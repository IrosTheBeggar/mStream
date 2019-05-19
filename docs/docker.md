### Install mStream with Docker

[LinuxServer.io](https://www.linuxserver.io/) have produced a multiarch Alpine container for mStream for `x86-64`, `arm64` & `armhf` which is rebuilt automatically with any base image package updates or new releases of mStream and features persistent database and album images, and the possibility of advanced usage by editing `config.json` directly.

Simply pulling `linuxserver/mstream` should retrieve the correct image for your arch, but you can also pull specific arch images or mStream releases via tags.

Here are some example snippets to help you get started creating a container.

### docker

```
docker create \
  --name=mstream \
  -e PUID=1000 \
  -e PGID=1000 \
  -e USER=admin \
  -e PASSWORD=password \
  -e USE_JSON=true/false \
  -e TZ=Europe/London \
  -p 3000:3000 \
  -v <path to data>:/config \
  -v <path to music>:/music \
  --restart unless-stopped \
  linuxserver/mstream
```


### docker-compose

Compatible with docker-compose v2 schemas.

```
---
version: "2"
services:
  mstream:
    image: linuxserver/mstream
    container_name: mstream
    environment:
      - PUID=1000
      - PGID=1000
      - USER=admin
      - PASSWORD=password
      - USE_JSON=true/false
      - TZ=Europe/London
    volumes:
      - <path to data>:/config
      - <path to music>:/music
    ports:
      - 3000:3000
    restart: unless-stopped
```

See the readme for more details on how to get up and running using docker or docker compose and further explanation of the environmental variables on either: 

* [Github](https://github.com/linuxserver/docker-mstream) *or*
* [Docker Hub](https://hub.docker.com/r/linuxserver/mstream)
