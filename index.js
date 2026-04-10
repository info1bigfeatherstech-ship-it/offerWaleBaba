const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// Import services
const { connectMongoDB, setupMongoDBEventHandlers } = require('./config/database.config');
const redisManager = require('./config/redis.config');
const { initCloudinary } = require('./config/cloudinary.config');
const gracefulShutdown = require('./services/shutdown.service');
const logger = require('./utils/logger');

// Import middleware
const { optionalAuth } = require('./middlewares/userTypeOptional');
const { limiters } = require('./middlewares/rateLimiter');

// Import routes (ACTIVE ONLY)
const authRoutes = require('./routes/authRoutes');
const adminProductsRoutes = require('./routes/adminProducts');
const categoriesRoutes = require('./routes/categories');
const productsRoutes = require('./routes/products');
const wishlistRoutes = require('./routes/wishlist');
const cartRoutes = require('./routes/Cart');
const addressRoutes = require('./routes/addressRoutes');
const adminAnalyticsRoutes = require('./routes/adminAnalyticsRoutes');

// =============================================
// COMMENTED ROUTES (Not active yet)
// =============================================
// const orderRoutes = require('./routes/orderRoutes');
// const wholesalerRoutes = require('./routes/wholesalerRoutes');
// const assistantRoutes = require('./routes/assistant.routes');
// const analyticsRoutes = require('./routes/seoAnalyticsRoutes');
// const adminCouponRoutes = require('./routes/adminCouponRoutes');
// const userCouponRoutes = require('./routes/userCouponRoutes');

// Configuration
const PORT = process.env.PORT || 8081;
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();
let server = null;

// ============================================================================
// Security & Middleware Setup
// ============================================================================
const allowedOrigins = [
  'https://offerwaalebaba.netlify.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

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
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,  // ✅ IMPORTANT - allows cookies
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Handle preflight requests
// app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ✅ Apply userType middleware (GLOBAL - for all routes)
app.use(optionalAuth);

// Request ID middleware
app.use((req, res, next) => {
  req.id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ============================================================================
// RATE LIMITING (Different limits for different routes)
// ============================================================================

// Public read operations - HIGH limit (products, categories)
app.use('/api/products', limiters.products);
app.use('/api/categories', limiters.categories);

// Search - MEDIUM limit
app.use('/api/products/search', limiters.search);

// Write operations - LOW limit (cart, wishlist, addresses)
app.use('/api/cart', limiters.write);
app.use('/api/wishlist', limiters.write);
app.use('/api/addresses', limiters.write);

// Sensitive operations - VERY LOW limit (auth)
app.use('/api/auth/login', limiters.sensitive);
app.use('/api/auth/register', limiters.sensitive);
app.use('/api/auth/otp-verify-login', limiters.sensitive);
app.use('/api/auth/forgot-password', limiters.sensitive);
app.use('/api/auth/change-password', limiters.sensitive);

// Admin operations - MEDIUM limit
app.use('/api/admin', limiters.admin);

// ============================================================================
// Health Check Endpoints (No rate limit)
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
    // MongoDB check
    if (mongoose.connection.readyState === 1) {
      healthStatus.services.mongodb = 'connected';
    } else {
      healthStatus.services.mongodb = 'disconnected';
      healthStatus.status = 'degraded';
    }

    // Redis check
    if (redisManager.isReady()) {
      await redisManager.getClient().ping();
      healthStatus.services.redis = 'connected';
    } else {
      healthStatus.services.redis = 'disconnected';
      if (NODE_ENV === 'production') {
        healthStatus.status = 'degraded';
      }
    }

    // Memory check
    const memUsage = process.memoryUsage();
    healthStatus.services.memory = {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
    };

    // Cache stats
    const cacheService = require('./services/cache.service');
    healthStatus.cache = cacheService.getStats();

    const statusCode = healthStatus.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(healthStatus);
  } catch (error) {
    healthStatus.status = 'unhealthy';
    healthStatus.error = error.message;
    res.status(503).json(healthStatus);
  }
});

app.get('/health/ready', async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_not_connected' });
  }

  if (!redisManager.isReady() && NODE_ENV === 'production') {
    return res.status(503).json({ status: 'not_ready', reason: 'cache_not_connected' });
  }

  res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
});

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Cache stats endpoint (for monitoring)
app.get('/api/cache/stats', async (req, res) => {
  const cacheService = require('./services/cache.service');
  res.json({
    success: true,
    stats: cacheService.getStats()
  });
});

// Helper function to get event loop lag
function getEventLoopLag() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1e6;
      resolve(`${Math.round(lag)}ms`);
    });
  });
}

// ============================================================================
// Routes - ONLY ACTIVE ROUTES
// ============================================================================

app.get('/api', (req, res) => {
  res.json({
    success: true,
    message: 'E-Commerce Platform API v1.0',
    status: 'running',
    version: '1.0.0',
    environment: NODE_ENV,
    userType: req.userType,
    activeEndpoints: {
      auth: '/api/auth',
      products: '/api/products',
      categories: '/api/categories',
      cart: '/api/cart',
      wishlist: '/api/wishlist',
      addresses: '/api/addresses',
      adminProducts: '/api/admin/products',
      adminAnalytics: '/api/admin/analytics'
    },
    health: '/health',
    cacheStats: '/api/cache/stats'
  });
});

// ✅ ACTIVE ROUTES
app.use('/api/auth', authRoutes);
app.use('/api/admin/products', adminProductsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/admin/analytics', adminAnalyticsRoutes);

// =============================================
// COMMENTED ROUTES (Uncomment when ready)
// =============================================
// app.use('/api/orders', orderRoutes);
// app.use('/api/wholesalers', wholesalerRoutes);
// app.use('/api/assistant', assistantRoutes);
// app.use('/api/analytics', analyticsRoutes);
// app.use('/api/admin/coupons', adminCouponRoutes);
// app.use('/api/coupons', userCouponRoutes);

// ============================================================================
// Error Handling Middleware
// ============================================================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
    timestamp: new Date().toISOString(),
    requestId: req.id
  });
});

app.use((err, req, res, next) => {
  logger.error(`[Error] ${err.message}`, { 
    stack: err.stack, 
    path: req.path, 
    method: req.method,
    requestId: req.id 
  });

  const statusCode = err.statusCode || 500;
  const message = NODE_ENV === 'production' && statusCode === 500
    ? 'Internal Server Error'
    : err.message;

  res.status(statusCode).json({
    success: false,
    error: err.name || 'Error',
    message,
    timestamp: new Date().toISOString(),
    requestId: req.id
  });
});

// ============================================================================
// Application Startup
// ============================================================================

async function startApplication() {
  try {
    logger.info(`Starting application in ${NODE_ENV} mode`);
    logger.info(`Node Version: ${process.version}`);

    // Initialize services
    initCloudinary();
    await connectMongoDB();
    setupMongoDBEventHandlers();

    // Connect to Redis (non-blocking)
    try {
      await redisManager.connect();
      logger.info('[Redis] Connected successfully');
      
      const cacheService = require('./services/cache.service');
      logger.info(`[Cache] Service ready, stats:`, cacheService.getStats());
    } catch (error) {
      logger.warn('[Redis] Running without Redis cache - functionality may be limited');
    }

    // Create HTTP server
    server = app.listen(PORT, () => {
      logger.info('='.repeat(70));
      logger.info(`✓ Server running on port ${PORT}`);
      logger.info(`✓ API Base URL: http://localhost:${PORT}/api`);
      logger.info(`✓ Health Check: http://localhost:${PORT}/health`);
      logger.info(`✓ Cache Stats: http://localhost:${PORT}/api/cache/stats`);
      logger.info('='.repeat(70));
      logger.info('Press CTRL+C to stop the server\n');
    });

    // Register server with shutdown service
    gracefulShutdown.registerServer(server);

    // Register database connections
    gracefulShutdown.registerConnection('MongoDB', async () => {
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.close(false);
      }
    });

    gracefulShutdown.registerConnection('Redis', async () => {
      await redisManager.disconnect();
    });

    // Setup process handlers
    gracefulShutdown.setupProcessHandlers();

    // Start health monitoring
    startHealthMonitoring();

  } catch (error) {
    logger.error(`Startup failed: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

function startHealthMonitoring() {
  setInterval(() => {
    const memUsage = process.memoryUsage();
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);
    
    if (rssMB > 500 && NODE_ENV === 'production') {
      logger.warn(`[Health] High memory usage: ${rssMB}MB`);
    }
    
    logger.debug(`[Health] Memory: ${rssMB}MB | Connections: ${server?.connections || 0}`);
  }, 30000);
}

// Start the application
startApplication();

module.exports = { app, gracefulShutdown };