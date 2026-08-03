const { app, BrowserWindow, Tray, Menu } = require('electron')
const path = require('path')

let win
let tray

function createWindow () {
  win = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#1e2228',
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Minimize hides to the tray on Linux/Windows instead of camping in the
  // taskbar — playback keeps running in the background (#795). Close (X)
  // still quits, so the default close behaviour is unchanged. macOS keeps
  // its native minimize-to-Dock.
  if (process.platform !== 'darwin') {
    win.on('minimize', (event) => {
      event.preventDefault()
      win.hide()
    })
  }

  win.loadFile('./index.html')
}

function showWindow () {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
    return
  }
  win.show()
  win.focus()
}

function createTray () {
  // velvet/build, NOT the top-level build/: that one is electron-builder's
  // buildResources dir and gets stripped from the packaged app — the
  // webapp's own copy under velvet/ is what actually ships in the asar.
  const icon = process.platform === 'darwin'
    ? 'velvet/build/tray-icon-osx.png'
    : 'velvet/build/tray-icon.png'
  try {
    tray = new Tray(path.join(__dirname, icon))
  } catch (_err) {
    // No tray host (some minimal desktops, CI) — the window keeps working,
    // and without a tray the minimize interception above would strand the
    // app, so put minimize back to its native behaviour.
    tray = null
    if (win) { win.removeAllListeners('minimize') }
    return
  }
  tray.setToolTip('mStream Desktop')
  // The context menu is the reliable way back: the StatusNotifierItem spec
  // leaves "activation" ambiguous across Linux environments (single click
  // in some, double click in others), so the left-click handler below is
  // best-effort and Show here is the guaranteed path.
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show mStream', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      }
    }
  ]))
  tray.on('click', showWindow)
}

app.whenReady().then(() => {
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
