const winston = require('winston');
require('winston-daily-rotate-file');
const os = require('os');

let fileTransport;

const myFormat = winston.format.printf(info => {
  let msg = `${info.timestamp} ${info.level}: ${info.message}`;
  if (!info.stack) { return msg; }

  const stackStr = typeof info.stack === 'string' ? 
    { stack: info.stack } :
    JSON.parse(JSON.stringify(info.stack, Object.getOwnPropertyNames(info.stack)));

  return msg +=  os.EOL + stackStr.stack;
});

winston.configure({
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        myFormat
      )
    })
  ],
  exitOnError: false
});

// 
const addFileLogger = (filepath) => {
  if (fileTransport) {
    this.reset();
  }

  fileTransport = new (winston.transports.DailyRotateFile)({
    filename: 'mstream-%DATE%',
    dirname: filepath,
    extension: '.log',
    datePattern: 'YYYY-MM-DD-HH',
    maxSize: '20m',
    maxFiles: '14d',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
  });

  winston.add(fileTransport);
}

const reset = () => {
  if (fileTransport) {
    winston.remove(fileTransport);
  }

  fileTransport = undefined;
}

module.exports = { reset, addFileLogger };
