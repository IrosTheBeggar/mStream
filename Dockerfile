FROM node:latest

ADD . /opt/mstream/
RUN cd /opt/mstream && npm install --only=production && npm link

EXPOSE 3000

VOLUME ["/music", "/beets.db"]

WORKDIR /music

ENTRYPOINT ["mstream"]
