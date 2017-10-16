## Install Electron Port

Installing the electron port will break the command line version of mStream.  

**Install Dev Dependencies**

Replace package.json with package.electron.json.  This file has some additional dependencies that the normal version. Then run `npm install` to install these new dependencies


**Boot It**

To boot mStream with Electron you have to run the following command:

```
# windows
.\node_modules\.bin\electron .

# Mac/Linux
./node_modules/.bin/electron .
```
