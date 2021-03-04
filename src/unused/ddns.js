const axios = require('axios');
const os = require('os');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const killQueue = require('../src/state/kill-list');
const eol = os.EOL;

var spawnedTunnel;
const apiEndpoint = 'https://api.mstream.io';
const platform = os.platform();
const osMap = {
  "win32": "rpn-win.exe",
  "darwin": "rpn-osx",
  "linux": "rpn-linux",
  "android": "rpn-android64"
};

killQueue.addToKillQueue(
  () => {
    // kill all workers
    if(spawnedTunnel) {
      spawnedTunnel.stdin.pause();
      spawnedTunnel.kill();
    }  
  }
);

exports.setup = async (program) => {
  if(spawnedTunnel || !program.ddns || !program.ddns.email || !program.ddns.password) {
    return;
  }

  login(program);
}

async function login(program) {
  var info;
  try {
    // login
    const loginRes = await axios({
      method: 'post',
      url: apiEndpoint + '/login', 
      headers: { 'accept': 'application/json' },
      responseType: 'json',
      data: {
        email: program.ddns.email,
        password: program.ddns.password
      }
    });

    // pull in config options
    const configRes = await axios({
      method: 'get',
      url: apiEndpoint + '/account/info',
      headers: { 'x-access-token': loginRes.data.token, 'accept': 'application/json' },
      responseType: 'json'
    });
    info = configRes.data;
  } catch (err) {
    winston.error('Login to Auto DNS Failed');
    winston.error(err.message);
    return;
  }

  // write config file for FRP
  try{
    const iniString = `[common]${eol}server_addr = ${info.ddnsAddress}${eol}server_port = ${info.ddnsPort}${eol}token = ${info.ddnsPassword}${eol}${eol}[web]${eol}type = http${eol}local_ip = 127.0.0.1${eol}custom_domains = ${info.subdomain}.${info.domain}${eol}local_port = ${program.port}`;
    fs.writeFileSync(program.ddns.iniFile, iniString);
  } catch(err) {
    winston.error('Failed to write FRP ini');
    winston.error(err.message);
    return;
  }

  // Boot it
  bootReverseProxy(program, info);
}

function bootReverseProxy(program, info) {
  if(spawnedTunnel) {
    winston.warn('Auto DNS: Tunnel already setup');
    // return;
  }

  try {
    spawnedTunnel = spawn(path.join(__dirname, `../bin/rpn/${osMap[platform]}`), ['-c', program.ddns.iniFile], {
      // shell: true,
      // cwd: path.join(__dirname, `../bin/rpn`),
    });

    spawnedTunnel.stdout.on('data', (data) => {
      // console.log(`stdout: ${data}`);
    });
    
    spawnedTunnel.stderr.on('data', (data) => {
      // console.log(`stderr: ${data}`);
    });

    spawnedTunnel.on('close', (code) => {
      winston.info('Auto DNS: Tunnel Closed. Attempting to reboot');
      setTimeout(() => {
        winston.info('Auto DNS: Rebooting Tunnel');
        // delete spawnedTunnel;
        bootReverseProxy(program, info);
      }, 4000);
    });

    winston.info('Auto DNS: Secure Tunnel Established');
    winston.info(`Access Your Server At: https://${info.subdomain}.${info.domain}`);
  }catch (err) {
    winston.error(`Failed to boot FRP`);
    winston.error(err.message);
    return;
  }
}