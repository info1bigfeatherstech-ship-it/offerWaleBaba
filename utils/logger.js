// const winston = require('winston');
// const path = require('path');

// const logFormat = winston.format.combine(
//   winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
//   winston.format.errors({ stack: true }),
//   winston.format.splat(),
//   winston.format.json(),
//   winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
//     return `${timestamp} [${level.toUpperCase()}] ${message} ${stack || ''} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
//   })
// );

// const logger = winston.createLogger({
//   level: process.env.LOG_LEVEL || 'info',
//   format: logFormat,
//   transports: [
//     new winston.transports.File({
//       filename: path.join('logs', 'error.log'),
//       level: 'error',
//       maxsize: 5242880, // 5MB
//       maxFiles: 5,
//     }),
//     new winston.transports.File({
//       filename: path.join('logs', 'combined.log'),
//       maxsize: 5242880,
//       maxFiles: 5,
//     }),
//   ],
// });

// if (process.env.NODE_ENV !== 'production') {
//   logger.add(new winston.transports.Console({
//     format: winston.format.combine(
//       winston.format.colorize(),
//       winston.format.simple()
//     ),
//   }));
// }

// // Create logs directory if it doesn't exist
// const fs = require('fs');
// if (!fs.existsSync(path.join('logs'))) {
//   fs.mkdirSync(path.join('logs'));
// }

// module.exports = logger;




// ===========================================
//for development only with console.log 
// ===========================================
// utils/logger.js - Development version (No file writing)
const logger = {
  info: (message, meta = {}) => {
    console.log(`[INFO] ${message}`, Object.keys(meta).length ? meta : '');
  },
  
  error: (message, meta = {}) => {
    console.error(`[ERROR] ${message}`, Object.keys(meta).length ? meta : '');
  },
  
  warn: (message, meta = {}) => {
    console.warn(`[WARN] ${message}`, Object.keys(meta).length ? meta : '');
  },
  
  debug: (message, meta = {}) => {
    console.debug(`[DEBUG] ${message}`, Object.keys(meta).length ? meta : '');
  }
};

module.exports = logger;