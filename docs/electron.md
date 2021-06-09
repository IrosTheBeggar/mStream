# Testing and Developing with Electron

```bash
# Install Electron
npm install -g electron

# Boot mStream with Electron
electron ./cli-boot-wrapper.js
```

# Compile with Electron Builder

All configuration for Electron Builder is stored in package.json

```shell
# Install
npm install -g electron-builder

# Compile
electron-builder
```

## Modify package.json (optional)

Remove all dependencies related to the command line (commander).  These packages will never be used by mStream Express and can be safely removed to reduce the output size

## Cleanup node_modules (optional)

Modclean can be used to clean out the node_modules folder of useless files.  This deletes over 1000 useless files saving space and shortening install time.  To install modlcean, run:

```shell
# Install modclean
npm install -g modclean

# Run modclean
modclean
```
