const winston = require('winston');
const path = require('path');
const os = require('os');

const logFileName = 'mstream.log';
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
  fileTransport = new winston.transports.File({
    filename: path.join(filepath, logFileName),
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
  })

  winston.add(fileTransport);
}

const reset = () => {
  winston.remove(fileTransport);
}

module.exports = { reset, addFileLogger };
