const redis = require('redis');

let redisClient = null;

const REDIS_RETRY_CONFIG = {
  maxRetries: 3,
  retryDelay: 2000,
  maxRetryDelay: 5000
};

// Return the current client
function getRedisClient() {
  return redisClient;
}

async function connectRedis() {
  return new Promise((resolve, reject) => {
    let retryCount = 0;
    let initialized = false;

    // Create client using .createClient with SSL auto
    const client = redis.createClient({
      url: process.env.REDIS_URL,
      socket: {
        // Enable TLS automatically if URL starts with rediss://
        tls: process.env.REDIS_URL?.startsWith('rediss://') ? true : false,
        reconnectStrategy: (retries) => {
          retryCount = retries;
          if (retries > REDIS_RETRY_CONFIG.maxRetries) {
            console.warn('[Redis] ⚠️ Max retries reached - continuing without Redis');
            if (!initialized) {
              initialized = true;
              resolve(null);
            }
            return false;
          }
          const delay = Math.min(
            REDIS_RETRY_CONFIG.retryDelay * Math.pow(2, retries),
            REDIS_RETRY_CONFIG.maxRetryDelay
          );
          console.log(`[Redis] Reconnecting in ${delay / 1000}s (Attempt ${retries+1})`);
          return delay;
        }
      }
    });

    // Listen error early
    client.on('error', (err) => {
      console.warn('[Redis] ⚠️ Error:', err.message);
    });

    client.on('connect', () => {
      console.log('[Redis] 🟡 Connecting...');
    });

    client.on('ready', () => {
      console.log('[Redis] 🟢 Connected ✔');
      if (!initialized) {
        initialized = true;
        redisClient = client;
        resolve(client);
      }
    });

    // Timeout if cannot connect
    const timeout = setTimeout(() => {
      if (!initialized) {
        initialized = true;
        console.warn('[Redis] ⚠️ Initial connect timeout - proceed without Redis');
        resolve(null);
      }
    }, 5000);

    // Attempt connect
    client.connect().catch((err) => {
      console.warn('[Redis] ⚠️ Failed to connect:', err.message);
      if (!initialized) {
        clearTimeout(timeout);
        initialized = true;
        resolve(null);
      }
    });
  });
}

module.exports = {
  connectRedis,
  getRedisClient
};