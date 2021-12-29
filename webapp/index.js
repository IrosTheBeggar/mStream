const { app, BrowserWindow } = require('electron')

function createWindow () {
  const win = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#1e2228',
    width: 1200,
    height: 800
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