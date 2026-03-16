
// this code have both functionality upload zip plus exel link 
const express = require('express');
const router  = express.Router();
const { body, validationResult } = require('express-validator');
const { requireAdmin } = require('../middlewares/isAdmin');
const {
  uploadProductImages,
  uploadCSVFile,
  uploadBulkFiles,
} = require('../middlewares/uploadMiddleware');
const productController = require('../controllers/productController');

const rejectSlugSku = (req, res, next) => {
  if ('slug' in req.body || 'sku' in req.body)
    return res.status(400).json({ success: false, message: 'slug and sku are auto-generated' });
  next();
};

// ── single product create ───────────────────────────────────
router.post('/', requireAdmin, uploadProductImages, rejectSlugSku,
  [
    body('name').trim().notEmpty().withMessage('Product name is required'),
    body('description').trim().notEmpty().withMessage('Description is required'),
    body('category').notEmpty().withMessage('Category is required'),
    body('variants.*.price.base').notEmpty().isNumeric().withMessage('Base price required'),
    body('status').optional().isIn(['draft','active','archived']).withMessage('Invalid status'),
    body('isFeatured').optional().isBoolean(),
  ],
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    next();
  },
  productController.createProduct
);

router.post('/bulk-create', requireAdmin, productController.bulkCreateProducts);

// ── BULK UPLOAD ─────────────────────────────────────────────
// Step 1 — preview (CSV/Excel only, no DB writes)
router.post('/preview-csv', requireAdmin, uploadCSVFile, productController.previewCSV);

// Step 2 — import
//   Mode A:  csvFile + imageMode=url          (image URLs in Excel)
//   Mode B:  csvFile + zipFile + imageMode=zip (ZIP folder of images)
router.post('/import-csv', requireAdmin, uploadBulkFiles, productController.importProductsFromCSV);

// ── other product routes (all unchanged) ───────────────────
router.get('/archived',            requireAdmin, productController.getArchivedProducts);
router.post('/bulk-delete',        requireAdmin, productController.bulkDelete);
router.patch('/bulk-restore',      requireAdmin, productController.bulkRestore);
router.get('/low-stock',           requireAdmin, productController.getLowStockProducts);
router.get('/drafts',              requireAdmin, productController.getDraftProducts);
router.get('/all',                 requireAdmin, productController.getAllProductsAdmin);
router.get('/',                    requireAdmin, productController.getAllActiveProducts);
router.delete('/bulk-hard-delete', requireAdmin, productController.bulkHardDelete);
router.patch('/restore/:slug',     requireAdmin, productController.restoreProduct);
router.delete('/hard/:slug',       requireAdmin, productController.hardDeleteProduct);
router.post('/:slug/variants',     requireAdmin, uploadProductImages, productController.addVariant);
router.delete('/:slug/variants',   requireAdmin, productController.deleteVariant);
router.get('/variant/:barcode',    requireAdmin, productController.getVariantByBarcode);
router.put('/:slug',               requireAdmin, uploadProductImages, rejectSlugSku, productController.updateProduct);
router.delete('/:slug',            requireAdmin, productController.deleteProduct);
router.get('/:slug',               requireAdmin, productController.getProductBySlug);

module.exports = router;
// this code have both functionality upload zip plus exel link 

// karan changes images upload with zip >>>>>>
// const express = require('express');
// const router  = express.Router();
// const { body, validationResult } = require('express-validator');
// const { requireAdmin } = require('../middlewares/isAdmin');
// const {
//   uploadProductImages,
//   uploadCSVFile,
//   uploadZIPFile,          // ← NEW: added for Step 2
// } = require('../middlewares/uploadMiddleware');
// const productController = require('../controllers/productController');

// const rejectSlugSku = (req, res, next) => {
//   if ('slug' in req.body || 'sku' in req.body) {
//     return res.status(400).json({ success: false, message: 'slug and sku are auto-generated; do not provide them' });
//   }
//   next();
// };

// // POST — create single product
// router.post(
//   '/',
//   requireAdmin,
//   uploadProductImages,
//   rejectSlugSku,
//   [
//     body('name').trim().notEmpty().withMessage('Product name is required'),
//     body('description').trim().notEmpty().withMessage('Product description is required'),
//     body('category').notEmpty().withMessage('Product category is required'),
//     body('variants.*.price.base').notEmpty().withMessage('Variant base price is required').isNumeric().withMessage('Variant base price must be a number'),
//     body('status').optional().isIn(['draft', 'active', 'archived']).withMessage('Invalid status'),
//     body('isFeatured').optional().isBoolean().withMessage('isFeatured must be true or false'),
//   ],
//   (req, res, next) => {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
//     next();
//   },
//   productController.createProduct
// );

// // Bulk create (JSON body — for testing)
// router.post('/bulk-create', requireAdmin, productController.bulkCreateProducts);

// // ─────────────────────────────────────────────────────────────
// // BULK UPLOAD — TWO STEP
// // Step 1: parse CSV/Excel, return preview (no DB writes)
// // Step 2: upload ZIP images + products JSON → save to DB
// // ─────────────────────────────────────────────────────────────
// router.post('/preview-csv', requireAdmin, uploadCSVFile,  productController.previewCSV);
// router.post('/import-csv',  requireAdmin, uploadZIPFile,  productController.importProductsFromCSV);

// // ─────────────────────────────────────────────────────────────
// // PRODUCT MANAGEMENT ROUTES (all unchanged)
// // ─────────────────────────────────────────────────────────────
// router.get('/archived',   requireAdmin, productController.getArchivedProducts);
// router.post('/bulk-delete', requireAdmin, productController.bulkDelete);
// router.patch('/bulk-restore', requireAdmin, productController.bulkRestore);
// router.get('/low-stock',  requireAdmin, productController.getLowStockProducts);
// router.get('/drafts',     requireAdmin, productController.getDraftProducts);
// router.get('/all',        requireAdmin, productController.getAllProductsAdmin);
// router.get('/',           requireAdmin, productController.getAllActiveProducts);
// router.delete('/bulk-hard-delete', requireAdmin, productController.bulkHardDelete);
// router.patch('/restore/:slug',     requireAdmin, productController.restoreProduct);
// router.delete('/hard/:slug',       requireAdmin, productController.hardDeleteProduct);
// router.post('/:slug/variants',     requireAdmin, uploadProductImages, productController.addVariant);
// router.delete('/:slug/variants',   requireAdmin, productController.deleteVariant);
// router.get('/variant/:barcode',    requireAdmin, productController.getVariantByBarcode);
// router.put('/:slug',               requireAdmin, uploadProductImages, rejectSlugSku, productController.updateProduct);
// router.delete('/:slug',            requireAdmin, productController.deleteProduct);
// router.get('/:slug',               requireAdmin, productController.getProductBySlug);

// module.exports = router;

// karan changes routes for preview ?? >> for images show with exel link
// const express = require('express');
// const router = express.Router();
// const { body, validationResult } = require('express-validator');
// const { requireAdmin } = require('../middlewares/isAdmin');
// const { uploadProductImages, uploadCSVFile } = require('../middlewares/uploadMiddleware');
// const productController = require('../controllers/productController');

// // Validation middleware to check for rejected fields
// const rejectSlugSku = (req, res, next) => {
//   if ('slug' in req.body || 'sku' in req.body) {
//     return res.status(400).json({ success: false, message: 'slug and sku are auto-generated; do not provide them' });
//   }
//   next();
// };

// // POST /admin/products Create new product with optional image uploads
// // Request body (form-data): name, description, category, price, inventory, variants, status
// // Files: images (array of up to 10 image files)
// router.post(
//   '/',
//   requireAdmin,
//   uploadProductImages,
//   rejectSlugSku,
//   [
//     body('name')
//       .trim()
//       .notEmpty()
//       .withMessage('Product name is required'),

//     body('description')
//       .trim()
//       .notEmpty()
//       .withMessage('Product description is required'),

//     body('category')
//       .notEmpty()
//       .withMessage('Product category is required'),

//     body('variants.*.price.base')
//       .notEmpty()
//       .withMessage('Variant base price is required')
//       .isNumeric()
//       .withMessage('Variant base price must be a number'),

//     body('status')
//       .optional()
//       .isIn(['draft', 'active', 'archived'])
//       .withMessage('Invalid status'),

//     body('isFeatured')
//       .optional()
//       .isBoolean()
//       .withMessage('isFeatured must be true or false')
//   ],
//   (req, res, next) => {
//     const errors = validationResult(req);

//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         success: false,
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     next();
//   },
//   productController.createProduct
// );

// // Bulk create (JSON body)
// router.post('/bulk-create', requireAdmin, productController.bulkCreateProducts);

// // Import from CSV
// router.post('/import-csv', requireAdmin,uploadCSVFile, productController.importProductsFromCSV);

// router.post('/preview-csv', requireAdmin, uploadCSVFile, productController.previewCSV);

// // Get archived products
// router.get('/archived', requireAdmin, productController.getArchivedProducts);

// // POST /admin/products/bulk-delete Bulk delete (archive)
// router.post('/bulk-delete', requireAdmin, productController.bulkDelete);

// // Bulk restore
// router.patch('/bulk-restore', requireAdmin, productController.bulkRestore);


// // GET /admin/products/low-stock Get low stock products
// router.get('/low-stock', requireAdmin, productController.getLowStockProducts);


// // Get draft products
// router.get('/drafts', requireAdmin, productController.getDraftProducts);

// //with limit and page query
// router.get('/all', requireAdmin, productController.getAllProductsAdmin);

// // Get all active products
// router.get('/', requireAdmin, productController.getAllActiveProducts);


// // Bulk hard delete
// router.delete('/bulk-hard-delete', requireAdmin, productController.bulkHardDelete);

// // Restore single
// router.patch('/restore/:slug', requireAdmin, productController.restoreProduct);


// // Hard delete single (only archived)
// router.delete('/hard/:slug', requireAdmin, productController.hardDeleteProduct);



// //post //add variant to product
// router.post('/:slug/variants', requireAdmin,  uploadProductImages, productController.addVariant);

// //delete variant from product
// router.delete('/:slug/variants', requireAdmin, productController.deleteVariant);

// //get variant by barcode
// router.get('/variant/:barcode', requireAdmin, productController.getVariantByBarcode);


// // PUT /admin/products/:slug Update product with optional image uploads
// router.put('/:slug', requireAdmin, uploadProductImages, rejectSlugSku, productController.updateProduct);

// // DELETE /admin/products/:slug Soft delete (archive)
// router.delete('/:slug', requireAdmin, productController.deleteProduct);


// //Get /admin/products/:slug get porduct by slug name 
// router.get('/:slug', requireAdmin, productController.getProductBySlug);



// module.exports = router;