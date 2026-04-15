const AnalyticsService = require('../services/seo-analytics.service');

const analyticsService = new AnalyticsService();

const sendJsonResponse = (res, status, payload) => {
  return res.status(status).json(payload);
};

const getOverview = async (req, res) => {
  try {
    const overview = await analyticsService.getOverview();
    return sendJsonResponse(res, 200, {
      success: true,
      data: overview
    });
  } catch (error) {
    console.error('[Analytics][Overview] Error:', error.message);
    return sendJsonResponse(res, error.statusCode || 500, {
      success: false,
      message: error.message || 'Unable to load analytics overview'
    });
  }
};

const getTraffic = async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const trafficData = await analyticsService.getTraffic(range);

    return sendJsonResponse(res, 200, {
      success: true,
      range,
      data: trafficData
    });
  } catch (error) {
    console.error('[Analytics][Traffic] Error:', error.message);
    return sendJsonResponse(res, error.statusCode || 500, {
      success: false,
      message: error.message || 'Unable to load traffic analytics'
    });
  }
};


const getDevices = async (req, res) => {
  try {
    const deviceCounts = await analyticsService.getDevices();
    return sendJsonResponse(res, 200, {
      success: true,
      data: deviceCounts
    });
  } catch (error) {
    console.error('[Analytics][Devices] Error:', error.message);
    return sendJsonResponse(res, error.statusCode || 500, {
      success: false,
      message: error.message || 'Unable to load device analytics'
    });
  }
};

const getSources = async (req, res) => {
  try {
    const sources = await analyticsService.getSources();
    return sendJsonResponse(res, 200, {
      success: true,
      data: sources
    });
  } catch (error) {
    console.error('[Analytics][Sources] Error:', error.message);
    return sendJsonResponse(res, error.statusCode || 500, {
      success: false,
      message: error.message || 'Unable to load source analytics'
    });
  }
};

const getLocations = async (req, res) => {
  try {
    const locations = await analyticsService.getLocations();
    return sendJsonResponse(res, 200, {
      success: true,
      data: locations
    });
  } catch (error) {
    console.error('[Analytics][Locations] Error:', error.message);
    return sendJsonResponse(res, error.statusCode || 500, {
      success: false,
      message: error.message || 'Unable to load location analytics'
    });
  }
};

module.exports = {
  getOverview,
  getTraffic,
  getDevices,
  getSources,
  getLocations
};
