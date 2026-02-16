const cloudinary = require('cloudinary').v2;

// ============================================================================
// CLOUDINARY CONFIGURATION
// ============================================================================

function initCloudinary() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
  
  console.log('[Cloudinary] ✓ Configured successfully');
}

module.exports = {
  initCloudinary,
  cloudinary
};