const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { requireAdmin } = require('../middlewares/isAdmin');
const { uploadProductImages, uploadCSVFile } = require('../middlewares/uploadMiddleware');
const productController = require('../controllers/productController');

// Validation middleware to check for rejected fields
const rejectSlugSku = (req, res, next) => {
  if ('slug' in req.body || 'sku' in req.body) {
    return res.status(400).json({ success: false, message: 'slug and sku are auto-generated; do not provide them' });
  }
  next();
};

// POST /admin/products Create new product with optional image uploads
// Request body (form-data): name, description, category, price, inventory, variants, status
// Files: images (array of up to 10 image files)
router.post(
  '/',
  requireAdmin,
  uploadProductImages,
  rejectSlugSku,
  [
    // =========================
    // BASIC REQUIRED FIELDS
    // =========================
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Product name is required'),

    body('description')
      .trim()
      .notEmpty()
      .withMessage('Product description is required'),

    body('category')
      .notEmpty()
      .withMessage('Product category is required'),

    // =========================
    // PRICE VALIDATION
    // =========================
    body('price').custom((val) => {
      if (val === undefined) {
        throw new Error('Price is required');
      }

      // If simple number
      if (typeof val === 'number' || !isNaN(Number(val))) {
        return true;
      }

      // If object
      if (typeof val === 'object') {
        if (!val.base) {
          throw new Error('Base price is required');
        }
        return true;
      }

      // If stringified JSON (form-data)
      if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val);
          if (!parsed.base) {
            throw new Error('Base price is required');
          }
          return true;
        } catch (err) {
          throw new Error('Invalid price format');
        }
      }

      throw new Error('Invalid price format');
    }),

    // =========================
    // STATUS VALIDATION
    // =========================
    body('status')
      .optional()
      .isIn(['draft', 'active', 'archived'])
      .withMessage('Invalid status'),

    // =========================
    // OPTIONAL BOOLEAN FIELD
    // =========================
    body('isFeatured')
      .optional()
      .isBoolean()
      .withMessage('isFeatured must be true or false')
  ],
  (req, res, next) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    next();
  },
  productController.createProduct
);


// Bulk create (JSON body)
router.post('/bulk-create', requireAdmin, productController.bulkCreateProducts);

// Import from CSV
router.post('/import-csv', requireAdmin, uploadCSVFile, productController.importProductsFromCSV);


// Get archived products
router.get('/archived', requireAdmin, productController.getArchivedProducts);

// POST /admin/products/bulk-delete Bulk delete (archive)
router.post('/bulk-delete', requireAdmin, productController.bulkDelete);

// Bulk restore
router.patch('/bulk-restore', requireAdmin, productController.bulkRestore);


// GET /admin/products/low-stock Get low stock products
router.get('/low-stock', requireAdmin, productController.getLowStockProducts);


// Get draft products
router.get('/drafts', requireAdmin, productController.getDraftProducts);


// Bulk hard delete
router.delete('/bulk-hard-delete', requireAdmin, productController.bulkHardDelete);

// Restore single
router.patch('/restore/:slug', requireAdmin, productController.restoreProduct);


// Hard delete single (only archived)
router.delete('/hard/:slug', requireAdmin, productController.hardDeleteProduct);


// PUT /admin/products/:slug Update product with optional image uploads
router.put('/:slug', requireAdmin, uploadProductImages, rejectSlugSku, productController.updateProduct);

// DELETE /admin/products/:slug Soft delete (archive)
router.delete('/:slug', requireAdmin, productController.deleteProduct);


//Get /admin/products/:slug get porduct by slug name 
router.get('/:slug', requireAdmin, productController.getProductBySlug);

// Get all active products
router.get('/', requireAdmin, productController.getAllProducts);




module.exports = router;
