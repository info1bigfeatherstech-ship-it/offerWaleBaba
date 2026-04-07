const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth');
const { authorizeRoles } = require('../middlewares/authorizeRoles');
const { uploadSingleImage } = require('../middlewares/uploadMiddleware');
const categoryController = require('../controllers/categoryController');

// Public category endpoints
router.get('/categories', categoryController.getAllCategories);
router.get('/categories/:id', categoryController.getCategoryById);

// Admin category endpoints
router.post('/admin/categories', verifyToken, authorizeRoles('admin', 'product_manager'), uploadSingleImage, categoryController.createCategory);
router.put('/admin/categories/:id', verifyToken, authorizeRoles('admin', 'product_manager'), uploadSingleImage, categoryController.updateCategory);
router.delete('/admin/categories/:id', verifyToken, authorizeRoles('admin', 'product_manager'), categoryController.deleteCategory);

module.exports = router;
