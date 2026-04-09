// const redis = require('redis');

// let redisClient = null;

// const REDIS_RETRY_CONFIG = {
//   maxRetries: 3,
//   retryDelay: 2000,
//   maxRetryDelay: 5000
// };

// // Return the current client
// function getRedisClient() {
//   return redisClient;
// }

// async function connectRedis() {
//   return new Promise((resolve, reject) => {
//     let retryCount = 0;
//     let initialized = false;

//     // Create client using .createClient with SSL auto
//     const client = redis.createClient({
//       url: process.env.REDIS_URL,
//       socket: {
//         // Enable TLS automatically if URL starts with rediss://
//         tls: process.env.REDIS_URL?.startsWith('rediss://') ? true : false,
//         reconnectStrategy: (retries) => {
//           retryCount = retries;
//           if (retries > REDIS_RETRY_CONFIG.maxRetries) {
//             console.warn('[Redis] ⚠️ Max retries reached - continuing without Redis');
//             if (!initialized) {
//               initialized = true;
//               resolve(null);
//             }
//             return false;
//           }
//           const delay = Math.min(
//             REDIS_RETRY_CONFIG.retryDelay * Math.pow(2, retries),
//             REDIS_RETRY_CONFIG.maxRetryDelay
//           );
//           console.log(`[Redis] Reconnecting in ${delay / 1000}s (Attempt ${retries+1})`);
//           return delay;
//         }
//       }
//     });

//     // Listen error early
//     client.on('error', (err) => {
//       console.warn('[Redis] ⚠️ Error:', err.message);
//     });

//     client.on('connect', () => {
//       console.log('[Redis] 🟡 Connecting...');
//     });

//     client.on('ready', () => {
//       console.log('[Redis] 🟢 Connected ✔');
//       if (!initialized) {
//         initialized = true;
//         redisClient = client;
//         resolve(client);
//       }
//     });

//     // Timeout if cannot connect
//     const timeout = setTimeout(() => {
//       if (!initialized) {
//         initialized = true;
//         console.warn('[Redis] ⚠️ Initial connect timeout - proceed without Redis');
//         resolve(null);
//       }
//     }, 5000);

//     // Attempt connect
//     client.connect().catch((err) => {
//       console.warn('[Redis] ⚠️ Failed to connect:', err.message);
//       if (!initialized) {
//         clearTimeout(timeout);
//         initialized = true;
//         resolve(null);
//       }
//     });
//   });
// }

// module.exports = {
//   connectRedis,
//   getRedisClient
// };


const redis = require('redis');
const logger = require('../utils/logger');

class RedisManager {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 3;
  }

  async connect() {
    try {
      this.client = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > this.maxRetries) {
              logger.error('[Redis] Max reconnection attempts reached');
              return new Error('Max reconnection attempts reached');
            }
            this.connectionAttempts = retries;
            logger.warn(`[Redis] Reconnection attempt ${retries}`);
            return Math.min(retries * 100, 3000);
          },
          connectTimeout: 10000,
          keepAlive: 30000,
        },
        retry_strategy: (options) => {
          if (options.error && options.error.code === 'ECONNREFUSED') {
            logger.error('[Redis] Connection refused');
            return new Error('Connection refused');
          }
          if (options.total_retry_time > 1000 * 60 * 5) {
            logger.error('[Redis] Retry time exhausted');
            return new Error('Retry time exhausted');
          }
          return Math.min(options.attempt * 100, 3000);
        },
        enable_offline_queue: false,
        lazyConnect: false,
      });

      this.client.on('connect', () => {
        logger.info('[Redis] Client connected');
        this.isConnected = true;
        this.connectionAttempts = 0;
      });

      this.client.on('ready', () => {
        logger.info('[Redis] Client ready for operations');
      });

      this.client.on('error', (err) => {
        logger.error(`[Redis] Client error: ${err.message}`);
        this.isConnected = false;
        // Don't crash the app on Redis errors
        if (process.env.NODE_ENV === 'production') {
          // Send alert to monitoring system
          this.sendAlertToMonitoring('Redis connection error', err);
        }
      });

      this.client.on('end', () => {
        logger.warn('[Redis] Connection ended');
        this.isConnected = false;
      });

      await this.client.connect();
      logger.info('[Redis] Connected successfully');
      return this.client;
    } catch (error) {
      logger.error(`[Redis] Connection failed: ${error.message}`);
      this.isConnected = false;
      
      // Don't throw - allow app to run without Redis in development
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }
      return null;
    }
  }

  async disconnect() {
    if (this.client && this.client.isOpen) {
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Redis disconnect timeout')), 5000)
      );
      
      await Promise.race([
        this.client.quit(),
        timeout
      ]).catch(err => {
        logger.error(`[Redis] Force closing connection: ${err.message}`);
        return this.client.disconnect();
      });
      
      this.isConnected = false;
      logger.info('[Redis] Disconnected gracefully');
    }
  }

  getClient() {
    return this.client;
  }

  isReady() {
    return this.isConnected && this.client && this.client.isOpen;
  }

  sendAlertToMonitoring(message, error) {
    // Integrate with your monitoring system (Datadog, NewRelic, etc.)
    if (process.env.DATADOG_API_KEY) {
      // Send to Datadog
      // Implementation depends on your monitoring setup
    }
  }
}

module.exports = new RedisManager();