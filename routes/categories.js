const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middlewares/isAdmin');
const { uploadSingleImage } = require('../middlewares/uploadMiddleware');
const categoryController = require('../controllers/categoryController');

// Public category endpoints
router.get('/categories', categoryController.getAllCategories);
router.get('/categories/:id', categoryController.getCategoryById);

// Admin routes for reordering and visibility
router.post('/admin/categories/reorder', requireAdmin, categoryController.reorderCategories);
router.patch('/admin/categories/:id/toggle-visibility', requireAdmin, categoryController.toggleCategoryVisibility);
router.get('/admin/categories/all', requireAdmin, categoryController.getAllCategoriesAdmin);//rmeove it we dont need it 
// Admin category endpoints
router.post('/admin/categories', requireAdmin, uploadSingleImage, categoryController.createCategory);
router.put('/admin/categories/:id', requireAdmin, uploadSingleImage, categoryController.updateCategory);
// Bulk reorder categories
router.post('/admin/categories/reorder', requireAdmin, categoryController.reorderCategories);
router.delete('/admin/categories/:id', requireAdmin, categoryController.deleteCategory);

module.exports = router;
