const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { verifyToken } = require('../middlewares/auth');
const { authorizeRoles } = require('../middlewares/authorizeRoles');
const { uploadProductImages, uploadCSVFile, uploadBulkNewProductFiles } = require('../middlewares/uploadMiddleware');
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
router.use(verifyToken);
router.use(authorizeRoles('admin', 'product_manager'));

router.post(
  '/',
  uploadProductImages,
  rejectSlugSku,
  [
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

    body('variants.*.price.base')
      .notEmpty()
      .withMessage('Variant base price is required')
      .isNumeric()
      .withMessage('Variant base price must be a number'),

    body('status')
      .optional()
      .isIn(['draft', 'active', 'archived'])
      .withMessage('Invalid status'),

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
// router.post('/bulk-create', productController.bulkCreateProducts);

// Import from CSV
router.post('/import-csv', uploadCSVFile, productController.importProductsFromCSV);


// Download error report
router.get('/download-error-report/:fileName', productController.downloadErrorReport);


//import csv for new products with images
router.post('/bulk-new-products', uploadBulkNewProductFiles, productController.bulkUploadNewProductsWithImages);

// Get archived products
router.get('/archived', productController.getArchivedProducts);

// POST /admin/products/bulk-delete Bulk delete (archive)
router.post('/bulk-delete', productController.bulkDelete);

// Bulk restore
router.patch('/bulk-restore', productController.bulkRestore);

// GET /admin/products/low-stock Get low stock products
router.get('/low-stock', productController.getLowStockProducts);

// Get draft products
router.get('/drafts', productController.getDraftProducts);

//with limit and page query
router.get('/all', productController.getAllProductsAdmin);

// Bulk hard delete
router.delete('/bulk-hard-delete', productController.bulkHardDelete);

// Restore single
router.patch('/restore/:slug', productController.restoreProduct);

// Hard delete single (only archived)
router.delete('/hard/:slug', productController.hardDeleteProduct);

//post //add variant to product
router.post('/:slug/variants', uploadProductImages, productController.addVariant);

//delete variant from product
router.delete('/:slug/variants', productController.deleteVariant);

//get variant by barcode
router.get('/variant/:barcode', productController.getVariantByBarcode);

// PUT /admin/products/:slug Update product with optional image uploads
router.put('/:slug', uploadProductImages, rejectSlugSku, productController.updateProduct);

// DELETE /admin/products/:slug Soft delete (archive)
router.delete('/:slug', productController.deleteProduct);

//Get /admin/products/:slug get porduct by slug name 
router.get('/:slug', productController.getProductBySlug);


// Get all active products
router.get('/', productController.getAllActiveProducts);


module.exports = router;
