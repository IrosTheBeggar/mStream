## Install on Ubuntu

**Dependencies**

mStream has the following dependencies:

* NodeJS and NPM
* Python 2
* GCC and G++
* node-gyp

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

Install through NPM

```shell
sudo npm install -g mstream

cd /path/to/your/music
mstream
```

Or Install through Git

```shell
git clone https://github.com/IrosTheBeggar/mStream.git

cd mStream

npm install

sudo npm link
```

Test it by running `mstream` in the terminal. Make sure it's working by checking out http://localhost:3000/
