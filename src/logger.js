const winston = require('winston');
require('winston-daily-rotate-file');
const os = require('os');

let fileTransport;

const myFormat = winston.format.printf(info => {
  return `${info.timestamp} ${info.level}: ${info.message}${info.stack ? os.EOL + info.stack.toString() : ''}`;
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
