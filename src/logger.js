const winston = require('winston');
const path = require('path');
const logFileName = 'mstream.log';

const myFormat = winston.format.printf(info => {
  return `${info.timestamp} ${info.level}: ${info.message}`;
});

const init = () => {
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
};

const addFileLogger = (filepath) => {
  winston.add(new winston.transports.File({
    filename: path.join(filepath, logFileName),
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
  }));
}

module.exports = { init, addFileLogger };
