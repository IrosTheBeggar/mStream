const { app, BrowserWindow, session } = require('electron')
const path = require('path')

// Register IPC handlers before any window is created
require('./main/ipc-handlers')

const config = require('./main/sync-config')
const urlInterceptor = require('./main/url-interceptor')
const scheduler = require('./main/sync-scheduler')

// Warm the config cache so the webRequest interceptor has data on first media
// request. Also install the redirect rule on the default session and start
// the snapshot-refresh scheduler.
app.whenReady().then(async () => {
  try { await config.load(); } catch { /* first run, no config yet */ }
  urlInterceptor.install(session.defaultSession)
  scheduler.start()
})

function createWindow () {
  const win = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#1e2228',
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  })
  win.loadFile('./index.html')
}

app.whenReady().then(() => {
  createWindow()

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