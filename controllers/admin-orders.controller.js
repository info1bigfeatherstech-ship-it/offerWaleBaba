/**
 * Admin / order_manager — read-only dashboard & order list for operations UI.
 */
const Order = require('../models/Order');
const logger = require('../utils/logger');
const {
  resolveDateRange,
  buildSearchFilter,
  buildBucketMatch,
  mergeFilters,
  aggregateSummary,
  mapOrderRow
} = require('../services/adminOrderDashboard.service');

function sendError(res, err, fallbackMessage) {
  const status = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  const code = err.code || (status === 400 ? 'BAD_REQUEST' : 'INTERNAL_ERROR');
  const message = status === 500 && process.env.NODE_ENV === 'production' ? fallbackMessage : err.message;
  if (status >= 500) {
    logger.error('[admin-orders]', { message: err.message, code, stack: err.stack });
  }
  return res.status(status).json({
    success: false,
    code,
    message: message || fallbackMessage
  });
}

/**
 * GET /api/admin/orders/summary
 * Query: from, to (ISO), presetDays (default 30 if no from/to), preset=30d alias
 */
exports.getDashboardSummary = async (req, res) => {
  try {
    let presetDays = req.query.presetDays;
    if (presetDays == null && String(req.query.preset || '').toLowerCase() === '30d') {
      presetDays = 30;
    }

    const rangePreset = req.query.rangePreset || req.query.range;

    const range = resolveDateRange({
      from: req.query.from,
      to: req.query.to,
      presetDays,
      rangePreset
    });

    const summary = await aggregateSummary(range.from, range.to);

    return res.json({
      success: true,
      data: {
        dateRange: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          preset: range.presetLabel
        },
        totals: {
          totalOrders: summary.totalOrders,
          /** Gross merchandise value in period (excludes cancelled & payment_failed). */
          totalRevenueInr: summary.totalRevenueInr,
          totalPendingOrders: summary.totalPendingOrders,
          totalCompletedOrders: summary.totalCompletedOrders
        },
        countsByBucket: summary.countsByBucket
      }
    });
  } catch (err) {
    return sendError(res, err, 'Could not load order summary');
  }
};

/**
 * GET /api/admin/orders
 * Query: from, to, presetDays, bucket, search, page, limit, sortBy, sortOrder
 */
exports.getOrdersList = async (req, res) => {
  try {
    let presetDays = req.query.presetDays;
    if (presetDays == null && String(req.query.preset || '').toLowerCase() === '30d') {
      presetDays = 30;
    }

    const rangePreset = req.query.rangePreset || req.query.range;

    const range = resolveDateRange({
      from: req.query.from,
      to: req.query.to,
      presetDays,
      rangePreset
    });

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const skip = (page - 1) * limit;

    const sortBy = ['createdAt', 'totalAmount', 'orderStatus'].includes(String(req.query.sortBy))
      ? String(req.query.sortBy)
      : 'createdAt';
    const sortOrder = String(req.query.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const sort = { [sortBy]: sortOrder };

    const dateMatch = { createdAt: { $gte: range.from, $lte: range.to } };
    const search = buildSearchFilter(req.query.search);
    const bucket = buildBucketMatch(req.query.bucket);
    const filter = mergeFilters(dateMatch, search, bucket);

    const [orders, total] = await Promise.all([
      Order.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Order.countDocuments(filter)
    ]);

    const rows = orders.map((doc) => mapOrderRow(doc));

    return res.json({
      success: true,
      data: {
        dateRange: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
          preset: range.presetLabel
        },
        orders: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 0,
          hasNextPage: page * limit < total,
          hasPrevPage: page > 1
        },
        filters: {
          bucket: String(req.query.bucket || 'all').toLowerCase(),
          search: req.query.search ? String(req.query.search).trim() : null
        }
      }
    });
  } catch (err) {
    return sendError(res, err, 'Could not load orders');
  }
};
