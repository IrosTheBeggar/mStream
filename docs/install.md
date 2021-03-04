## Install on Ubuntu

**Dependencies**

* NodeJS and NPM
* git

**Install NodeJS & git**

```shell
curl -sL https://deb.nodesource.com/setup_12.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs

sudo-apt-get install git
```

**Install mStream**

```shell
git clone https://github.com/IrosTheBeggar/mStream.git

cd mStream

# Install without dev dependencies
npm install

sudo npm link
```

**Updating mStream**

To update mStream just pull the changes from git and reboot your server

```shell
git pull
```
