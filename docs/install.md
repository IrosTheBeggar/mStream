## Install on Ubuntu

**Dependencies**

mStream has the following dependencies:

* NodeJS and NPM
* Python 2
* GCC and G++
* node-gyp
* git

**Install NodeJS**

```shell
curl -sL https://deb.nodesource.com/setup_6.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs
```

**Install GCC and node-gyp**

```shell
sudo apt-get install -y build-essential
sudo npm install -g node-gyp
```

**Install mStream**

Install mStream with git.  You can install mStream from npm, but this has been known to cause errors

```shell
git clone https://github.com/IrosTheBeggar/mStream.git

cd mStream

npm install

sudo npm link
```

Test it by running `mstream` in the terminal. Make sure it's working by checking out http://localhost:3000/

**Configure mStream**

[mStream can be configured with command line arguments.](cli_arguments.md)
