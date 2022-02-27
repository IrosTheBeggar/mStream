## Install on Ubuntu

**Dependencies**

* NodeJS and NPM
* git

[How to Install NodeJS](https://nodejs.org/en/download/package-manager/)

# Install mStream

```shell
git clone https://github.com/IrosTheBeggar/mStream.git

cd mStream

# Install dependencies and run
npm run-script wizard
```

# Running mStream as a Background Process

We will use [PM2](https://pm2.keymetrics.io/) to run mStream as a background process

```shell
# Install PM2
npm install -g pm2

# Run app
pm2 start cli-boot-wrapper.js --name mStream
```

[See the PM2 docs for more information](https://pm2.keymetrics.io/docs/usage/quick-start/)

# Updating mStream

To update mStream just pull the changes from git and reboot your server

```shell
git pull
npm install --only=prod
# Reboot mStream with PM2
pm2 restart all
```
