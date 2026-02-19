const Category = require('../models/Category');
const Product = require('../models/Product');
const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinaryHelper');

// Get all categories (hierarchical)
// const getAllCategories = async (req, res) => {
//   try {
//     const categories = await Category.find().sort({ order: 1, name: 1 }).lean();

//     const map = new Map();
//     categories.forEach(cat => { cat.children = []; map.set(String(cat._id), cat); });

//     const roots = [];
//     categories.forEach(cat => {
//       if (cat.parent) {
//         const p = map.get(String(cat.parent));
//         if (p) p.children.push(cat);
//         else roots.push(cat);
//       } else {
//         roots.push(cat);
//       }
//     });

//     return res.status(200).json({ success: true, count: categories.length, categories: roots });
//   } catch (error) {
//     console.error('Get categories error:', error);
//     return res.status(500).json({ success: false, message: 'Error fetching categories', error: error.message });
//   }
// };
// Get all categories (hierarchical + filtered)
// Get all active categories (hierarchical)
const getAllCategories = async (req, res) => {
  try {
    // Only active categories
    const categories = await Category.find({ isActive: true })
      .sort({ order: 1, name: 1 })
      .lean();

    const map = new Map();

    // Prepare map and add children array
    categories.forEach(cat => {
      cat.children = [];
      map.set(String(cat._id), cat);
    });

    const roots = [];

    // Build hierarchy
    categories.forEach(cat => {
      if (cat.parentCategory) {
        const parent = map.get(String(cat.parentCategory));
        if (parent) {
          parent.children.push(cat);
        } else {
          roots.push(cat);
        }
      } else {
        roots.push(cat);
      }
    });

    return res.status(200).json({
      success: true,
      count: categories.length,
      categories: roots
    });

  } catch (error) {
    console.error('Get categories error:', error);

    return res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
};


// Get single category
// const getCategoryById = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const cat = await Category.findById(id).lean();
//     if (!cat) return res.status(404).json({ success: false, message: 'Category not found' });
//     return res.status(200).json({ success: true, category: cat });
//   } catch (error) {
//     console.error('Get category error:', error);
//     return res.status(500).json({ success: false, message: 'Error fetching category', error: error.message });
//   }
// };

// Get single active category by ID
const getCategoryById = async (req, res) => {
  try {
    const { id } = req.params;

    // Only fetch if active
    const category = await Category.findOne({
      _id: id,
      isActive: true
    }).lean();

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    return res.status(200).json({
      success: true,
      category
    });

  } catch (error) {
    console.error('Get category error:', error);

    return res.status(500).json({
      success: false,
      message: 'Error fetching category',
      error: error.message
    });
  }
};



// Create category (admin)
// const createCategory = async (req, res) => {
//   try {
//     const { name, description, parent, order, status } = req.body;
//     if (!name) return res.status(400).json({ success: false, message: 'Category name is required' });

//     const category = new Category({ name, description: description || '', parent: parent || null, order: order || 0, status: status || 'active' });

//     // calculate level
//     if (parent) {
//       const p = await Category.findById(parent);
//       category.level = p ? (p.level || 0) + 1 : 0;
//     } else {
//       category.level = 0;
//     }

//     // handle image upload
//     if (req.file && req.file.buffer) {
//       try {
//         const { url, publicId } = await uploadToCloudinary(req.file.buffer, 'categories');
//         category.image = { url, publicId };
//       } catch (err) {
//         console.error('Category image upload failed:', err.message);
//       }
//     }

//     await category.save();
//     return res.status(201).json({ success: true, message: 'Category created', category });
//   } catch (error) {
//     console.error('Create category error:', error);
//     return res.status(500).json({ success: false, message: 'Error creating category', error: error.message });
//   }
// };


const createCategory = async (req, res) => {
  try {
    const {
      name,
      description,
      parentCategory,
      order,
      isActive,
      showInMenu
    } = req.body;

    // 1️⃣ Validate name
    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Category name is required'
      });
    }

    // 2️⃣ If parentCategory provided, verify it exists
    if (parentCategory) {
      const parentExists = await Category.findById(parentCategory);

      if (!parentExists || !parentExists.isActive) {
        return res.status(400).json({
          success: false,
          message: 'Invalid or inactive parent category'
        });
      }
    }

    // 3️⃣ Create category object
    const category = new Category({
      name,
      description: description || '',
      parentCategory: parentCategory || null,
      order: order || 0,
      isActive: isActive !== undefined ? isActive : true,
      showInMenu: showInMenu !== undefined ? showInMenu : true
    });

   
    // 4️⃣ Handle image upload
    if (req.file && req.file.buffer) {
      try {
        const { url, publicId } = await uploadToCloudinary(
          req.file.buffer,
          'categories'
        );

        category.image = { url, publicId };
      } catch (err) {
        console.error('Category image upload failed:', err.message);
      }
    }

    await category.save();

    return res.status(201).json({
      success: true,
      message: 'Category created successfully',
      category
    });

  } catch (error) {
    console.error('Create category error:', error);

    return res.status(500).json({
      success: false,
      message: 'Error creating category',
      error: error.message
    });
  }
};



// Update category (admin)
const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, parent, order, status } = req.body;

    const category = await Category.findById(id);
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

    if (name) category.name = name;
    if (description !== undefined) category.description = description;
    if (order !== undefined) category.order = order;
    if (status) category.status = status;

    if (parent) {
      const p = await Category.findById(parent);
      category.parent = p ? p._id : null;
      category.level = p ? (p.level || 0) + 1 : 0;
    } else if (parent === null || parent === 'null') {
      category.parent = null;
      category.level = 0;
    }

    // image handling
    if (req.file && req.file.buffer) {
      try {
        // delete old image if exists
        if (category.image && category.image.publicId) await deleteFromCloudinary(category.image.publicId);
        const { url, publicId } = await uploadToCloudinary(req.file.buffer, 'categories');
        category.image = { url, publicId };
      } catch (err) {
        console.error('Category image upload failed:', err.message);
      }
    }

    await category.save();
    return res.status(200).json({ success: true, message: 'Category updated', category });
  } catch (error) {
    console.error('Update category error:', error);
    return res.status(500).json({ success: false, message: 'Error updating category', error: error.message });
  }
};

// Delete category (admin) - soft delete (set status to 'inactive')
// Prevent deletion if any products reference this category
const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    // 1️⃣ Check if category exists
    const category = await Category.findById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // 2️⃣ Prevent deleting already inactive category
    if (!category.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Category is already inactive'
      });
    }

    // 3️⃣ Check if any active subcategories exist
    const childCategories = await Category.countDocuments({
      parentCategory: id,
      isActive: true
    });

    if (childCategories > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category. ${childCategories} active subcategory(s) exist.`
      });
    }

    // 4️⃣ Check if any products reference this category
    const productCount = await Product.countDocuments({
      category: id
    });

    if (productCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category. ${productCount} product(s) are using this category.`
      });
    }

    // 5️⃣ Soft delete (archive)
    category.isActive = false;
    category.showInMenu = false;

    await category.save();

    return res.status(200).json({
      success: true,
      message: 'Category archived successfully',
      category
    });

  } catch (error) {
    console.error('Delete category error:', error);

    return res.status(500).json({
      success: false,
      message: 'Error deleting category',
      error: error.message
    });
  }
};



module.exports = { getAllCategories, getCategoryById, createCategory, updateCategory, deleteCategory };
