## The Quick And Dirty Way 

Use the `nohup` command and `&` symbol to run a process in the background 

```
nohup mstream -j /path/to/config.json &
```

Or you can install screen to run a terminal session forever

```
sudo apt install screen
screen
```

## The Proper Way - Using PM2

Install PM2

```shell
# Install PM2
npm install -g pm2
```

Write your PM2 config file.

```
module.exports = {
  apps : [{
    name   : "mstream",
    script : "./cli-boot-wrapper.js",
    cwd    : "./mStream",
    args   : [ "-j", "/path/to/config.json"]
  }]
}
```

Start PM2

```
pm2 start pm2.config.js
pm2 startup systemd
```

This will return instructions on how to run PM2 on reboot.

```
pm2 save
```

Some commands for managing PM2

```
pm2 stop all
pm2 restart all
pm2 start all

pm2 logs
```
