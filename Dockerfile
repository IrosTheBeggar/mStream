FROM node:argon

RUN npm install -g mstream

EXPOSE 3000

VOLUME ["/music", "/beets.db"]

WORKDIR /music

ENTRYPOINT ["mstream"]
