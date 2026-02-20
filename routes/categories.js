const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middlewares/isAdmin');
const { uploadSingleImage } = require('../middlewares/uploadMiddleware');
const categoryController = require('../controllers/categoryController');

// Public category endpoints
router.get('/categories', categoryController.getAllCategories);
router.get('/categories/:id', categoryController.getCategoryById);

// Admin category endpoints
router.post('/admin/categories', requireAdmin, uploadSingleImage, categoryController.createCategory);
router.put('/admin/categories/:id', requireAdmin, uploadSingleImage, categoryController.updateCategory);
router.delete('/admin/categories/:id', requireAdmin, categoryController.deleteCategory);

module.exports = router;
