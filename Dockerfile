FROM node:latest

RUN apt-get update
RUN apt-get install -y build-essential python
RUN npm install -g node-gyp

WORKDIR /mstream

# Change the version to install in this line (or use "master.tar.gz" for the latest)
RUN curl -L "https://github.com/IrosTheBeggar/mStream/archive/master.tar.gz" | tar -xz --strip-components=1
RUN npm install && npm link

EXPOSE 3000
VOLUME ["/music", "/data"]

WORKDIR /data
ENTRYPOINT ["mstream", "-m", "/music", "-p", "3000"]

# Use:
# docker build local/mstream [dir with this file]
# docker run --rm -v /path/to/music:/music:ro -v /path/to/datadir:/data -p 3000:3000 local/mstream
