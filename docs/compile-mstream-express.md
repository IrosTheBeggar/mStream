These instructions change regularly.  Steps marked optional are meant there to make the final app size smaller.

**Install Dependencies**

```shell
# Install electron-packager
npm install -g electron-packager

# Install modclean (optional)
npm install -g modclean

# Install electron globally (optional)
npm install -g electron
```

**Reinstall node_modules (optional)**

**Cleanup node_modules (optional)**

Modclean can be used to clean out the node_modules folder of useless files.  This deletes over 1000 useless files saving space and shortening install time.  To install modlcean, run:

```
npm install -g modclean
```

Then run modclean with:

```
modclean
```

Additional files can be deleted recursively on windows with the command

```
del /s .gitignore
```

**Compile**

Compile with electron-packager

```
electron-packager  mStream\ mstreamExpress --platform=win32 --arch=x64 --icon=mstream-electron\images\mstream-logo-cut.ico --electron-version=1.6.2
```

**Package with INNO**
