Alternative packaging steps

**Install Dependencies**

```shell
npm install -g electron-builder

# Install modclean (optional)
npm install -g modclean
```

**Modify package.json (optional)**

Remove all dependencies related to the command line (commander, inquirer, colors).  These packages will never be used by mStream Express and can be safely removed to reduce the output size

**Cleanup node_modules (optional)**

Modclean can be used to clean out the node_modules folder of useless files.  This deletes over 1000 useless files saving space and shortening install time.  To install modlcean, run:

```
npm install -g modclean
```

Then run modclean with:

```
modclean
```

**Compile**

```shell
# OSX
electron-builder
```

**Code Signing**

* OSX: Follow instructions here https://www.electron.build/code-signing.  No modifications to the project needed
* Windows: