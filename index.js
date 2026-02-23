

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

