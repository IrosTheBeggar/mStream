const winston = require('winston');

const myFormat = winston.format.printf(info => {
  return `${info.timestamp} ${info.level}: ${info.message}`;
});

const init = () => {
  winston.configure({
    transports: [
      new winston.transports.Console()
    ],
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp(),
      myFormat
    ),
    exitOnError: false
  });
};

module.exports = { init };
