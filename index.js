// /**
//  * E-Commerce Platform - Main Application Entry Point
//  * 
//  * @description Production-grade server with graceful shutdown, error recovery,
//  *              and system failure handling to ensure zero user experience disruption
//  * @version 1.0.0
//  * @author BigFeathersTech Development Team
//  * 
//  */

// const express = require('express');
// const mongoose = require('mongoose');
// const redis = require('redis');  // COMMENTED OUT - NOW IN CONFIG
// const helmet = require('helmet');
// const cors = require('cors');
// const rateLimit = require('express-rate-limit');
// const morgan = require('morgan');
// require('dotenv').config();

// // ============================================================================
// // IMPORT CONFIG FILES
// // ============================================================================

// const { connectMongoDB, setupMongoDBEventHandlers, mongoConnection } = require('./config/database.config');
// const { connectRedis, redisClient } = require('./config/redis.config');
// const { initCloudinary, cloudinary } = require('./config/cloudinary.config');

// // ============================================================================
// // IMPORT ROUTES
// // ============================================================================

// const authRoutes = require('./routes/authRoutes');

// // ============================================================================
// // CONFIGURATION & CONSTANTS
// // ============================================================================

// const PORT = process.env.PORT || 5000;
// const NODE_ENV = process.env.NODE_ENV || 'development';
// const SHUTDOWN_TIMEOUT = 30000; // 30 seconds for graceful shutdown
// const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

// // Connection retry configuration
// const MONGODB_RETRY_CONFIG = {
//   maxRetries: 5,
//   retryDelay: 5000,
//   backoffMultiplier: 2
// };

// const REDIS_RETRY_CONFIG = {
//   maxRetries: 10,
//   retryDelay: 3000,
//   maxRetryDelay: 30000
// };

// // ============================================================================
// // APPLICATION INITIALIZATION
// // ============================================================================

// const app = express();

// // ============================================================================
// // SECURITY MIDDLEWARE
// // ============================================================================

// // Helmet: Security headers (XSS, clickjacking, etc.)
// app.use(helmet({
//   contentSecurityPolicy: {
//     directives: {
//       defaultSrc: ["'self'"],
//       styleSrc: ["'self'", "'unsafe-inline'"],
//       scriptSrc: ["'self'"],
//       imgSrc: ["'self'", 'https://res.cloudinary.com', 'data:'],
//     },
//   },
//   hsts: {
//     maxAge: 31536000,
//     includeSubDomains: true,
//     preload: true
//   }
// }));


// // CORS Configuration
// const corsOptions = {
//   origin: process.env.FRONTEND_URL || 'http://localhost:5173',
//   credentials: true,
//   optionsSuccessStatus: 200,
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
//   allowedHeaders: ['Content-Type', 'Authorization']
// };
// app.use(cors(corsOptions));

// // Rate Limiting: 100 requests per 15 minutes per IP
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 100,
//   message: 'Too many requests from this IP, please try again later.',
//   standardHeaders: true,
//   legacyHeaders: false,
//   skip: (req) => {
//     // Skip rate limiting for health checks
//     return req.path === '/health' || req.path === '/api/health';
//   }
// });
// app.use('/api/', limiter);

// // ============================================================================
// // REQUEST PARSING & LOGGING
// // ============================================================================

// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// // Request logging (Morgan)
// if (NODE_ENV === 'production') {
//   app.use(morgan('combined'));
// } else {
//   app.use(morgan('dev'));
// }

// // Request ID injection for tracing
// app.use((req, res, next) => {
//   req.id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
//   res.setHeader('X-Request-ID', req.id);
//   next();
// });

// // ============================================================================
// // CONNECTION MANAGERS WITH RETRY LOGIC
// // ============================================================================

// // let mongoConnection = null;    // REMOVED - NOW IN CONFIG
// // let redisClient = null;        // REMOVED - NOW IN CONFIG
// let server = null;

// // ============================================================================
// // HEALTH CHECK ENDPOINTS
// // ============================================================================

// /**
//  * Comprehensive Health Check
//  */
// app.get('/health', async (req, res) => {
//   const healthStatus = {
//     status: 'healthy',
//     timestamp: new Date().toISOString(),
//     uptime: process.uptime(),
//     environment: NODE_ENV,
//     services: {
//       mongodb: 'unknown',
//       redis: 'unknown',
//       memory: 'unknown'
//     }
//   };

//   try {
//     // Check MongoDB
//     if (mongoose.connection.readyState === 1) {
//       healthStatus.services.mongodb = 'connected';
//     } else {
//       healthStatus.services.mongodb = 'disconnected';
//       healthStatus.status = 'degraded';
//     }

//     // Check Redis
//     if (redisClient && redisClient.isOpen) {
//       await redisClient.ping();
//       healthStatus.services.redis = 'connected';
//     } else {
//       healthStatus.services.redis = 'disconnected';
//       healthStatus.status = 'degraded';
//     }

//     // Check Memory
//     const memUsage = process.memoryUsage();
//     const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);
//     const memLimitMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    
//     healthStatus.services.memory = `${memUsageMB}MB / ${memLimitMB}MB`;
    
//     if (memUsageMB / memLimitMB > 0.9) {
//       healthStatus.status = 'degraded';
//       healthStatus.warning = 'High memory usage';
//     }

//     const statusCode = healthStatus.status === 'healthy' ? 200 : 503;
//     res.status(statusCode).json(healthStatus);
    
//   } catch (error) {
//     healthStatus.status = 'unhealthy';
//     healthStatus.error = error.message;
//     res.status(503).json(healthStatus);
//   }
// });

// /**
//  * Liveness Probe (for Kubernetes/container orchestration)
//  */
// app.get('/health/live', (req, res) => {
//   res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
// });

// /**
//  * Readiness Probe (for load balancers)
//  */
// app.get('/health/ready', async (req, res) => {
//   try {
//     if (mongoose.connection.readyState !== 1) {
//       return res.status(503).json({ status: 'not_ready', reason: 'database_not_connected' });
//     }

//     if (!redisClient || !redisClient.isOpen) {
//       return res.status(503).json({ status: 'not_ready', reason: 'cache_not_connected' });
//     }

//     res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
//   } catch (error) {
//     res.status(503).json({ status: 'not_ready', error: error.message });
//   }
// });

// // ============================================================================
// // API ROUTES (Placeholder - Add your routes here)
// // ============================================================================

// app.get('/api', (req, res) => {
//   res.json({
//     message: 'E-Commerce Platform API v1.0',
//     status: 'running',
//     documentation: '/api/docs',
//     health: '/health'
//   });
// });

// // Auth Routes
// app.use('/api/auth', authRoutes);

// // Admin Product Routes
// const adminProductsRoutes = require('./routes/adminProducts');
// app.use('/api/admin/products', adminProductsRoutes);

// // ============================================================================
// // ERROR HANDLING MIDDLEWARE
// // ============================================================================

// /**
//  * 404 Not Found Handler
//  */
// app.use((req, res, next) => {
//   res.status(404).json({
//     error: 'Not Found',
//     message: `Cannot ${req.method} ${req.path}`,
//     timestamp: new Date().toISOString(),
//     requestId: req.id
//   });
// });

// /**
//  * Global Error Handler
//  */
// app.use((err, req, res, next) => {
//   // Log error with request context
//   console.error('[Error]', {
//     requestId: req.id,
//     method: req.method,
//     path: req.path,
//     error: err.message,
//     stack: NODE_ENV === 'development' ? err.stack : undefined
//   });

//   // Don't expose internal errors in production
//   const statusCode = err.statusCode || err.status || 500;
//   const message = NODE_ENV === 'production' && statusCode === 500
//     ? 'Internal Server Error'
//     : err.message;

//   res.status(statusCode).json({
//     error: err.name || 'Error',
//     message,
//     timestamp: new Date().toISOString(),
//     requestId: req.id,
//     ...(NODE_ENV === 'development' && { stack: err.stack })
//   });
// });

// // ============================================================================
// // GRACEFUL SHUTDOWN HANDLER
// // ============================================================================

// /**
//  * Graceful Shutdown Orchestration
//  * Ensures no user requests are interrupted during shutdown
//  */
// async function gracefulShutdown(signal) {
//   console.log(`\n[Shutdown] ${signal} received. Starting graceful shutdown...`);
//   console.log('[Shutdown] No new connections will be accepted');
  
//   const shutdownStart = Date.now();
//   let shutdownTimer;

//   // Force shutdown after timeout
//   shutdownTimer = setTimeout(() => {
//     console.error('[Shutdown] ✗ Forced shutdown after timeout');
//     process.exit(1);
//   }, SHUTDOWN_TIMEOUT);

//   try {
//     // Step 1: Stop accepting new connections
//     if (server) {
//       console.log('[Shutdown] Closing HTTP server...');
//       await new Promise((resolve, reject) => {
//         server.close((err) => {
//           if (err) {
//             console.error('[Shutdown] Error closing HTTP server:', err.message);
//             reject(err);
//           } else {
//             console.log('[Shutdown] ✓ HTTP server closed');
//             resolve();
//           }
//         });
//       });
//     }

//     // Step 2: Wait for active requests to complete (server.close handles this)
//     console.log('[Shutdown] Waiting for active requests to complete...');
//     await new Promise(resolve => setTimeout(resolve, 2000));
//     console.log('[Shutdown] ✓ All active requests completed');

//     // Step 3: Close Redis connection
//     if (redisClient && redisClient.isOpen) {
//       console.log('[Shutdown] Closing Redis connection...');
//       await redisClient.quit();
//       console.log('[Shutdown] ✓ Redis connection closed');
//     }

//     // Step 4: Close MongoDB connection
//     if (mongoConnection) {
//       console.log('[Shutdown] Closing MongoDB connection...');
//       await mongoose.connection.close(false);
//       console.log('[Shutdown] ✓ MongoDB connection closed');
//     }

//     clearTimeout(shutdownTimer);
    
//     const shutdownDuration = ((Date.now() - shutdownStart) / 1000).toFixed(2);
//     console.log(`[Shutdown] ✓ Graceful shutdown completed in ${shutdownDuration}s`);
//     console.log('[Shutdown] Goodbye! 👋\n');
    
//     process.exit(0);
//   } catch (error) {
//     clearTimeout(shutdownTimer);
//     console.error('[Shutdown] ✗ Error during shutdown:', error.message);
//     process.exit(1);
//   }
// }

// // ============================================================================
// // PROCESS EVENT HANDLERS
// // ============================================================================

// // Graceful shutdown signals
// process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// // Uncaught Exception Handler
// process.on('uncaughtException', (error) => {
//   console.error('[Fatal] Uncaught Exception:', error);
//   console.error(error.stack);
  
//   // Log to external service (Sentry, etc.) in production
//   // await logToSentry(error);
  
//   // Attempt graceful shutdown
//   gracefulShutdown('UNCAUGHT_EXCEPTION');
// });

// // Unhandled Promise Rejection Handler
// process.on('unhandledRejection', (reason, promise) => {
//   console.error('[Fatal] Unhandled Promise Rejection at:', promise);
//   console.error('[Fatal] Reason:', reason);
  
//   // Log to external service (Sentry, etc.) in production
//   // await logToSentry(reason);
  
//   // Attempt graceful shutdown
//   gracefulShutdown('UNHANDLED_REJECTION');
// });

// // Warning Handler (e.g., deprecated APIs)
// process.on('warning', (warning) => {
//   console.warn('[Warning]', warning.name, warning.message);
//   if (warning.stack) {
//     console.warn(warning.stack);
//   }
// });

// // ============================================================================
// // APPLICATION STARTUP
// // ============================================================================

// /**
//  * Initialize and Start Application
//  */
// async function startApplication() {
//   try {
//     console.log('='.repeat(70));
//     console.log('E-COMMERCE PLATFORM - STARTUP SEQUENCE');
//     console.log('='.repeat(70));
//     console.log(`Environment: ${NODE_ENV}`);
//     console.log(`Node Version: ${process.version}`);
//     console.log(`Platform: ${process.platform}`);
//     console.log(`PID: ${process.pid}`);
//     console.log('='.repeat(70));

//     // Initialize Cloudinary
//     console.log('\n[0/3] Initializing Cloudinary...');
//     initCloudinary();

//     // Step 1: Connect to MongoDB
//     console.log('\n[1/3] Initializing MongoDB connection...');
//     await connectMongoDB();
//     setupMongoDBEventHandlers();

//     // Step 2: Connect to Redis (Optional)
//     console.log('\n[2/3] Initializing Redis connection...');
//     try {
//       await connectRedis();
//     } catch (error) {
//       console.warn('[Redis] ⚠️ Redis connection failed, continuing without cache:', error.message);
//     }

//     // Step 3: Start HTTP Server
//     console.log('\n[3/3] Starting HTTP server...');
//     server = app.listen(PORT, () => {
//       console.log('='.repeat(70));
//       console.log(`✓ Server is running on port ${PORT}`);
//       console.log(`✓ API Base URL: http://localhost:${PORT}/api`);
//       console.log(`✓ Health Check: http://localhost:${PORT}/health`);
//       console.log('='.repeat(70));
//       console.log('Press CTRL+C to stop the server\n');
//     });

//     // Configure server for graceful shutdown
//     server.keepAliveTimeout = 65000;
//     server.headersTimeout = 66000;

//     // Periodic health checks
//     setInterval(() => {
//       const memUsage = process.memoryUsage();
//       const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      
//       console.log(`[Health] Memory: ${memUsageMB}MB | MongoDB: ${mongoose.connection.readyState === 1 ? '✓' : '✗'} | Redis: ${redisClient?.isOpen ? '✓' : '✗'}`);
//     }, HEALTH_CHECK_INTERVAL);

//   } catch (error) {
//     console.error('\n[Startup] ✗ Failed to start application:', error.message);
//     console.error(error.stack);
//     process.exit(1);
//   }
// }

// // ============================================================================
// // START THE APPLICATION
// // ============================================================================

// startApplication();

// // ============================================================================
// // EXPORTS (for testing)
// // ============================================================================

// module.exports = { app, gracefulShutdown };




/**
 * E-Commerce Platform - Main Application Entry Point
 * Production-grade server with graceful shutdown & monitoring
 */

const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// ============================================================================
// IMPORT CONFIG FILES
// ============================================================================

const { connectMongoDB, setupMongoDBEventHandlers } = require('./config/database.config');
const { connectRedis, redisClient } = require('./config/redis.config');
const { initCloudinary } = require('./config/cloudinary.config');

// ============================================================================
// IMPORT ROUTES
// ============================================================================

const authRoutes = require('./routes/authRoutes');
const adminProductsRoutes = require('./routes/adminProducts');
const categoriesRoutes = require('./routes/categories');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const SHUTDOWN_TIMEOUT = 30000;
const HEALTH_CHECK_INTERVAL = 30000;

const app = express();
let server = null;


// ============================================================================
// SECURITY MIDDLEWARE
// ============================================================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'https://res.cloudinary.com', 'data:'],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(cors({
  origin: [process.env.FRONTEND_URL || 'http://localhost:5173' , 'http://127.0.0.1:5500' , 'http://localhost:5500'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie']
}));

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skip: (req) => req.path === '/health' || req.path === '/api/health'
}));


// ============================================================================
// BODY PARSING & LOGGING
// ============================================================================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

// Cookie parser for reading refresh-token cookie
app.use(cookieParser());

// Serve simple frontend test pages (e.g., google-test)
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  req.id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ============================================================================
// HEALTH CHECK ENDPOINTS (UPDATED)
// ============================================================================

app.get('/health', async (req, res) => {
  const healthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: NODE_ENV,
    services: {
      mongodb: 'unknown',
      redis: 'unknown',
      memory: 'unknown'
    }
  };

  try {
    // MongoDB
    if (mongoose.connection.readyState === 1) {
      healthStatus.services.mongodb = 'connected';
    } else {
      healthStatus.services.mongodb = 'disconnected';
      healthStatus.status = 'degraded';
    }

    // Redis (Only degrade in production)
    if (redisClient && redisClient.isOpen) {
      await redisClient.ping();
      healthStatus.services.redis = 'connected';
    } else {
      healthStatus.services.redis = 'disconnected';
      if (NODE_ENV === 'production') {
        healthStatus.status = 'degraded';
      }
    }

    // ✅ MEMORY CHECK (Improved Version Using RSS)
    const memUsage = process.memoryUsage();
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);
    healthStatus.services.memory = `${rssMB}MB`;

    // Only warn in production if memory is truly high
    if (NODE_ENV === 'production' && rssMB > 500) {
      healthStatus.status = 'degraded';
      healthStatus.warning = 'High memory usage';
    }

    const statusCode = healthStatus.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(healthStatus);

  } catch (error) {
    healthStatus.status = 'unhealthy';
    healthStatus.error = error.message;
    res.status(503).json(healthStatus);
  }
});

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/health/ready', async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_not_connected' });
  }

  if (redisClient && !redisClient.isOpen && NODE_ENV === 'production') {
    return res.status(503).json({ status: 'not_ready', reason: 'cache_not_connected' });
  }

  res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
});

// ============================================================================
// ROUTES
// ============================================================================

app.get('/api', (req, res) => {
  res.json({
    message: 'E-Commerce Platform  v1.0',
    status: 'running',
    health: '/health'
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/admin/products', adminProductsRoutes);
app.use('/api', categoriesRoutes);


// ============================================================================
// ERROR HANDLING
// ============================================================================
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
    timestamp: new Date().toISOString(),
    requestId: req.id
  });
});

app.use((err, req, res, next) => {
  console.error('[Error]', err);

  const statusCode = err.statusCode || 500;
  const message =
    NODE_ENV === 'production' && statusCode === 500
      ? 'Internal Server Error'
      : err.message;

  res.status(statusCode).json({
    error: err.name || 'Error',
    message,
    timestamp: new Date().toISOString(),
    requestId: req.id
  });
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

async function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] ${signal} received...`);
  setTimeout(() => {
    console.error('[Shutdown] Forced exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  if (server) {
    await new Promise(resolve => server.close(resolve));
  }

  if (redisClient?.isOpen) {
    await redisClient.quit();
  }

  await mongoose.connection.close(false);

  console.log('[Shutdown] Completed');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[Fatal]', err);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (reason) => {
  console.error('[Fatal]', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// ============================================================================
// START APPLICATION
// ============================================================================
async function startApplication() {
  try {
    console.log(`Environment: ${NODE_ENV}`);
    console.log(`Node Version: ${process.version}`);

    initCloudinary();

    await connectMongoDB();
    setupMongoDBEventHandlers();

    try {
      await connectRedis();
    } catch (err) {
      console.warn('[Redis] Running without Redis cache');
    }

    // server = app.listen(PORT, () => {
    //   console.log(`Server running on port ${PORT}`);
    //   console.log(`Health: http://localhost:${PORT}/health`);
    // });
    // Step 3: Start HTTP Server
    console.log('\n[3/3] Starting HTTP server...');
    server = app.listen(PORT, () => {
      console.log('='.repeat(70));
      console.log(`✓ Server is running on port ${PORT}`);
      console.log(`✓ API Base URL: http://localhost:${PORT}/api`);
      console.log(`✓ Health Check: http://localhost:${PORT}/health`);
      console.log('='.repeat(70));
      console.log('Press CTRL+C to stop the server\n');
    });

    setInterval(() => {
      const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      console.log(`[Health] Memory: ${rssMB}MB`);
    }, HEALTH_CHECK_INTERVAL);

  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
}

startApplication();

module.exports = { app, gracefulShutdown };

