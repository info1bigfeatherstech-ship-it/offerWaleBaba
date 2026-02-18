const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { requireAdmin } = require('../middlewares/isAdmin');
const { uploadProductImages } = require('../middlewares/uploadMiddleware');
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
  uploadProductImages, // Handle image uploads
  rejectSlugSku,
  [
    body('name').trim().notEmpty().withMessage('Product name is required'),
   body('price').custom(val => {
  if (val === undefined) return true;

  if (
    typeof val === 'number' ||
    !isNaN(Number(val)) ||
    typeof val === 'object'
  ) {
    return true;
  }

  throw new Error('price must be a number or object with base/sale properties');
}),
    body('status').optional().isIn(['draft', 'active', 'archived']).withMessage('Invalid status')
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }
    next();
  },
  productController.createProduct
);

// PUT /admin/products/:id Update product with optional image uploads
router.put('/:id', requireAdmin, uploadProductImages, rejectSlugSku, productController.updateProduct);

// DELETE /admin/products/:id Soft delete (archive)
router.delete('/:id', requireAdmin, productController.deleteProduct);

// POST /admin/products/bulk-delete Bulk delete (archive)
router.post('/bulk-delete', requireAdmin, productController.bulkDelete);

// PUT /admin/products/:id/restore Restore archived product
router.put('/:id/restore', requireAdmin, productController.restoreProduct);

// GET /admin/products/low-stock Get low stock products
router.get('/low-stock', requireAdmin, productController.getLowStockProducts);

module.exports = router;
