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

**Install Dependencies**

```shell
sudo apt-get install -y build-essential git python
sudo npm install -g node-gyp
```

**Install mStream**

Install mStream with git.  You can install mStream from npm, but this has been known to cause errors

```shell
git clone https://github.com/IrosTheBeggar/mStream.git

cd mStream

# Install without dev dependencies
npm install --only=production

sudo npm link
```

**Using mStream**

You can now boot your mStream server by running `mstream` in the terminal.  By default mStream will use port 3000, so you can check if it's working by going to http://localhost:3000/ in your browser.

You can set the music folder with the `-m` flag (example: `mstream -m /path/to/your/music`).  You must use the full path name with this flag.  If you do not set this flag, mStream will use the current directory.

You can protect your server with a user + password with the `-u` and `-x` flags.  For example: `mstream -u admin -x password`.  If you do not set these flags, your server will be accessible to anyone.

For more information on configuring mStream:
* [More information one setting up mStream with the command line](cli_arguments.md)
* [Configuring mStream with a JSON file](json_config.md)


**mStream + Electron (The Precursor to mStream Express)**

mStream server can be configured to be booted through Electron.  From here, electron can be used to compile the entire package into mStream Express.

Setting up mStream + Electron will break the command line version of mStream.  If you want to go back from Electron to the CLI, you will have to delete your node_modules folder and rerun `npm install`

[Click here for the full instructions](electron-install.md)
