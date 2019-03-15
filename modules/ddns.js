const publicIp = require('public-ip');
const superagent = require('superagent');

var apiKey;

// TODO: Experimental function to clean the users cache
function flushDNSCache() {
  if (process.platform === 'win32') {
    const ls = require('child_process').spawn('ipconfig.exe', ["\/flushdns"]);
    ls.stdout.on('data', (data) => { console.log(`stdout: ${data}`); });
    ls.stderr.on('data', (data) => { console.log(`stderr: ${data}`); });
    ls.on('close', (code) => { console.log(`child process exited with code ${code}`); });
  }
}

// Function that updates IP
var currentIP;
function updateIP() {
  console.log('UPDATING IP')
  publicIp.v4().then(ip => {
    if (ip !== currentIP) {
      superagent.post('https://ddns.mstream.io/update/ip')
        .set('x-access-token', apiKey)
        .set('Accept', 'application/json')
        .send({ ip: ip })
        .end(function (err, res) {
          console.log('IP Update happened');
          if (err || !res.ok) {
            console.log('Update IP failed');
            console.log(err);
          }
        });
    }
    currentIP = ip;
  });
}


// Check if the user is logged in
var configFile = fe.join(app.getPath('userData'), 'save/mstream-api-token.json');
try {
  if (fs.statSync(configFile).isFile()) {
    apiKey = fs.readFileSync(configFile, 'utf8');


    // Make sure key is valid and working
    superagent.get('https://ddns.mstream.io/login-status?token=' + apiKey).end(function (err, res) {
      if (err || !res.ok) {
        console.log('Error checking login status');
        console.log(err);
        return;
      }

      // Update IP every minute
      setInterval(function () { updateIP(); }, 60000);

      trayTemplate[9].submenu = [
        {
          label: 'Force IP Update', click: function () {
            updateIP();
          }
        },
        { type: 'separator' },
        {
          label: 'Logout', click: function () {
            app.isQuiting = true;

            fs.writeFileSync(fe.join(app.getPath('userData'), 'save/mstream-api-token.json'), '', 'utf8');
            fs.writeFileSync(fe.join(app.getPath('userData'), 'save/temp-boot-disable.json'), JSON.stringify({ disable: true }), 'utf8');
            app.relaunch();
            app.quit();
          }
        }
      ]

      try {
        var parsedRes = JSON.parse(res.text);
        // Add domain to list of domains
        var add = 'https://' + parsedRes.full_domain + ':' + program.port;
        trayTemplate[3].submenu.push({
          label: add, click: function () {
            shell.openExternal(add)
          }
        })
      } catch (err) {

      }

      appIcon.setContextMenu(Menu.buildFromTemplate(trayTemplate));
    });
  }
} catch (error) {
  
}