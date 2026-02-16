const redis = require('redis');

// ============================================================================
// CONNECTION MANAGERS WITH RETRY LOGIC
// ============================================================================

let redisClient = null;

const REDIS_RETRY_CONFIG = {
  maxRetries: 3,
  retryDelay: 2000,
  maxRetryDelay: 5000
};

/**
 * Redis Connection with Exponential Backoff Retry (Optional - Non-Blocking)
 * App will start even if Redis is unavailable
 */
async function connectRedis() {
  return new Promise((resolve, reject) => {
    let retryCount = 0;
    let hasInitialized = false;
    
    const client = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => {
          retryCount = retries;
          
          if (retries > REDIS_RETRY_CONFIG.maxRetries) {
            console.warn('[Redis] ⚠️ Max retry attempts reached - continuing without Redis cache');
            if (!hasInitialized) {
              hasInitialized = true;
              resolve(null); // Resolve without Redis
            }
            return false; // Stop retrying
          }
          
          const delay = Math.min(
            REDIS_RETRY_CONFIG.retryDelay * Math.pow(2, retries),
            REDIS_RETRY_CONFIG.maxRetryDelay
          );
          
          console.log(`[Redis] Reconnecting in ${delay / 1000}s... (Attempt ${retries + 1}/${REDIS_RETRY_CONFIG.maxRetries})`);
          return delay;
        }
      }
    });

    // Set a timeout for initial connection attempt
    const connectionTimeout = setTimeout(() => {
      if (!hasInitialized) {
        hasInitialized = true;
        console.warn('[Redis] ⚠️ Connection timeout - continuing without Redis cache');
        resolve(null); // Resolve without Redis
      }
    }, 5000);

    client.on('connect', () => {
      console.log('[Redis] ✓ Connected successfully');
    });

    client.on('ready', () => {
      console.log('[Redis] ✓ Ready to accept commands');
      clearTimeout(connectionTimeout);
      if (!hasInitialized) {
        hasInitialized = true;
        redisClient = client;
        resolve(client);
      }
    });

    client.on('error', (err) => {
      console.warn('[Redis] ⚠️ Error:', err.message);
      
      if (!hasInitialized && retryCount === 0) {
        // Don't block app startup on first error
        clearTimeout(connectionTimeout);
        hasInitialized = true;
        resolve(null); // Continue without Redis
      }
    });

    client.on('reconnecting', () => {
      console.log('[Redis] Attempting to reconnect...');
    });

    client.on('end', () => {
      console.log('[Redis] Connection closed');
    });

    client.connect().catch((err) => {
      if (!hasInitialized) {
        hasInitialized = true;
        clearTimeout(connectionTimeout);
        console.warn('[Redis] ⚠️ Failed to connect:', err.message);
        resolve(null); // Continue without Redis
      }
    });
  });
}

module.exports = {
  connectRedis,
  redisClient
};