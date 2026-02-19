const Product = require('../models/Product');
const Category = require('../models/Category');
const mongoose = require('mongoose');
const slugify = require('slugify');
const { generateSlug, generateSku } = require('../utils/productUtils');
const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinaryHelper');
const sharp = require('sharp');

// Create new product

const createProduct = async (req, res) => {
  try {
    const {
      name,
      description,
      shortDescription,
      category,
      brand,
      price,
      inventory,
      shipping,
      attributes,
      isFeatured,
      status
    } = req.body;

    // =========================
    // REQUIRED VALIDATION
    // =========================
    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Product name is required'
      });
    }

    if (!description) {
      return res.status(400).json({
        success: false,
        message: 'Product description is required'
      });
    }

    if (!category) {
      return res.status(400).json({
        success: false,
        message: 'Product category is required'
      });
    }

    // =========================
    // RESOLVE CATEGORY (accept id or name/slug)
    // =========================
    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    let categoryId;

    if (mongoose.Types.ObjectId.isValid(category)) {
      const found = await Category.findById(category);
      if (!found) {
        return res.status(400).json({ success: false, message: 'Invalid category id' });
      }
      categoryId = found._id;
    } else {
      // try to find by slug or name (case-insensitive)
      const candidateSlug = slugify(String(category), { lower: true, strict: true });
      let found = await Category.findOne({ $or: [{ slug: candidateSlug }, { name: new RegExp('^' + escapeRegExp(String(category)) + '$', 'i') }] });

      // create category automatically if not found
      if (!found) {
        const newCat = new Category({ name: String(category), slug: candidateSlug, status: 'active', level: 0 });
        await newCat.save();
        found = newCat;
      }

      categoryId = found._id;
    }

    // =========================
    // Generate slug & SKU
    // =========================
    const slug = await generateSlug(name);
    const sku = await generateSku();

    // =========================
    // HANDLE PRICE (JSON or STRING)
    // =========================
    let parsedPrice = price;

    // If coming from form-data as stringified JSON
    if (typeof price === 'string') {
      try {
        parsedPrice = JSON.parse(price);
      } catch (err) {
        parsedPrice = {};
      }
    }

    let priceObj = {
      base: 0,
      sale: null,
      costPrice: null,
      saleStartDate: null,
      saleEndDate: null
    };

    if (parsedPrice !== undefined) {
      // If number only
      if (!isNaN(parsedPrice)) {
        priceObj.base = Number(parsedPrice);
      }

      // If object
      else if (typeof parsedPrice === 'object' && parsedPrice !== null) {
        priceObj.base = Number(parsedPrice.base) || 0;
        priceObj.sale = parsedPrice.sale
          ? Number(parsedPrice.sale)
          : null;

        priceObj.costPrice = parsedPrice.costPrice
          ? Number(parsedPrice.costPrice)
          : null;

        priceObj.saleStartDate = parsedPrice.saleStartDate
          ? new Date(parsedPrice.saleStartDate)
          : null;

        priceObj.saleEndDate = parsedPrice.saleEndDate
          ? new Date(parsedPrice.saleEndDate)
          : null;
      }
    }

    // Extra safety validation
    if (priceObj.sale && priceObj.sale >= priceObj.base) {
      return res.status(400).json({
        success: false,
        message: 'Sale price must be less than base price'
      });
    }

    if (
      priceObj.saleStartDate &&
      priceObj.saleEndDate &&
      priceObj.saleStartDate > priceObj.saleEndDate
    ) {
      return res.status(400).json({
        success: false,
        message: 'Sale start date cannot be after sale end date'
      });
    }

    // =========================
    // HANDLE INVENTORY
    // =========================
    const inventoryObj = {
      quantity: inventory?.quantity || 0,
      trackInventory: inventory?.trackInventory !== false,
      lowStockThreshold: inventory?.lowStockThreshold || 5
    };

    // =========================
    // HANDLE SHIPPING
    // =========================
    const shippingObj = {
      weight: shipping?.weight || 0,
      dimensions: {
        length: shipping?.dimensions?.length || 0,
        width: shipping?.dimensions?.width || 0,
        height: shipping?.dimensions?.height || 0
      }
    };

    // =========================
    // HANDLE ATTRIBUTES
    // =========================
    let attributesArr = [];

    if (attributes) {
      let parsedAttributes = attributes;

      if (typeof attributes === 'string') {
        try {
          parsedAttributes = JSON.parse(attributes);
        } catch (err) {
          parsedAttributes = [];
        }
      }

      if (Array.isArray(parsedAttributes)) {
        attributesArr = parsedAttributes.map(attr => ({
          key: attr.key,
          value: attr.value
        }));
      }
    }

    // =========================
    // HANDLE IMAGE UPLOADS (UNCHANGED)
    // =========================
    let images = [];

    if (req.files && req.files.length > 0) {
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];

        try {
          const metadata = await sharp(file.buffer).metadata();

          if (
            metadata.width > 5000 ||
            metadata.height > 5000
          ) {
            throw new Error('Image dimensions too large (max 5000px allowed)');
          }

          const optimizedBuffer = await sharp(file.buffer)
            .resize({
              width: 1500,
              withoutEnlargement: true
            })
            .webp({ quality: 80 })
            .toBuffer();

          const { url, publicId } = await uploadToCloudinary(
            optimizedBuffer,
            `products/${slug}`
          );

          images.push({
            url,
            publicId,
            altText:
              req.body[`images[${i}].altText`] ||
              `Product image ${i + 1}`,
            order: i
          });

        } catch (uploadError) {
          console.error(
            `Error processing image ${i}:`,
            uploadError.message
          );
        }
      }
    }

    // =========================
    // CREATE PRODUCT
    // =========================
    const product = new Product({
      name,
      slug,
      sku,
      description,
      shortDescription: shortDescription || '',
      category: categoryId,
      brand: brand || 'Generic',
      price: priceObj,
      inventory: inventoryObj,
      shipping: shippingObj,
      images,
      attributes: attributesArr,
      isFeatured: isFeatured === true || isFeatured === 'true',
      status: status || 'draft'
    });

    await product.save();

    return res.status(201).json({
      success: true,
      message: 'Product created successfully',
      product
    });

  } catch (error) {
    console.error('Create product error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error creating product',
      error: error.message
    });
  }
};


// Update product
// const updateProduct = async (req, res) => {
//   try {
//     const id = req.params.id;
    
//     // Prevent manual changes to slug and sku — generated server-side
//     const updates = { ...req.body };
//     if ('slug' in updates) delete updates.slug;
//     if ('sku' in updates) delete updates.sku;

//     // Handle uploaded images via Multer
//     if (req.files && req.files.length > 0) {
//       const newImages = [];
//       for (let i = 0; i < req.files.length; i++) {
//         const file = req.files[i];
//         try {
//           const { url, publicId } = await uploadToCloudinary(file.buffer, 'products');
//           newImages.push({
//             url,
//             publicId,
//             altText: req.body[`images[${i}].altText`] || `Product image ${i + 1}`,
//             order: (updates.images?.length || 0) + i
//           });
//         } catch (uploadError) {
//           console.error(`Error uploading image ${i}:`, uploadError.message);
//         }
//       }
//       // Append new images to existing ones
//       updates.images = [...(updates.images || []), ...newImages];
//     }

//     // Normalize images order if provided
//     if (Array.isArray(updates.images)) {
//       updates.images = updates.images.map((img, idx) => ({ ...img, order: typeof img.order === 'number' ? img.order : idx }));
//     }

//     const product = await Product.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });
//     if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

//     return res.status(200).json({ success: true, message: 'Product updated', product });
//   } catch (error) {
//     console.error('Update product error:', error);
//     return res.status(500).json({ success: false, message: 'Error updating product', error: error.message });
//   }
// };


const updateProduct = async (req, res) => {
  try {
    const id = req.params.id;

    // 1️⃣ Find existing product
    const existingProduct = await Product.findById(id);
    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const updates = { ...req.body };

    // 2️⃣ Prevent slug & sku manual update
    if ('slug' in updates) delete updates.slug;
    if ('sku' in updates) delete updates.sku;

    // 3️⃣ Convert price (form-data safe)
    if (updates.price) {
      let parsedPrice = updates.price;

      if (typeof parsedPrice === 'string') {
        parsedPrice = Number(parsedPrice);
      }

      if (!isNaN(parsedPrice)) {
        updates.price = { base: parsedPrice };
      }
    }

    // ===================================================
    // 4️⃣ HANDLE IMAGE DELETION (if frontend sends images)
    // ===================================================
    if (Array.isArray(updates.images)) {

      const existingPublicIds = existingProduct.images.map(img => img.publicId);
      const updatedPublicIds = updates.images.map(img => img.publicId);

      const removedImages = existingPublicIds.filter(
        id => !updatedPublicIds.includes(id)
      );

      // Delete removed images from Cloudinary
      for (const publicId of removedImages) {
        await deleteFromCloudinary(publicId);
      }
    }

    // ===================================================
    // 5️⃣ HANDLE NEW IMAGE UPLOADS
    // ===================================================
    if (req.files && req.files.length > 0) {

      const newImages = [];

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];

        try {
          // Validate dimensions
          const metadata = await sharp(file.buffer).metadata();

          if (
            metadata.width > 5000 ||
            metadata.height > 5000
          ) {
            throw new Error('Image dimensions too large (max 5000px)');
          }

          // Resize + convert to WebP
          const optimizedBuffer = await sharp(file.buffer)
            .resize({
              width: 1500,
              withoutEnlargement: true
            })
            .webp({ quality: 80 })
            .toBuffer();

          // Upload to Cloudinary
          const { url, publicId } = await uploadToCloudinary(
            optimizedBuffer,
            'products'
          );

          newImages.push({
            url,
            publicId,
            altText:
              req.body[`images[${i}].altText`] ||
              `Product image ${i + 1}`,
            order: existingProduct.images.length + i
          });

        } catch (err) {
          console.error(`Image ${i} upload failed:`, err.message);
        }
      }

      // Merge existing (after deletion) + new
      updates.images = [
        ...(updates.images || existingProduct.images),
        ...newImages
      ];
    }

    // ===================================================
    // 6️⃣ Normalize Image Order
    // ===================================================
    if (Array.isArray(updates.images)) {
      updates.images = updates.images.map((img, index) => ({
        ...img,
        order: typeof img.order === 'number' ? img.order : index
      }));
    }

    // ===================================================
    // 7️⃣ Update Product
    // ===================================================
    // If name changed, regenerate slug server-side
    if (updates.name && updates.name !== existingProduct.name) {
      try {
        const newSlug = await generateSlug(updates.name, id);
        updates.slug = newSlug;
      } catch (err) {
        console.error('Failed to generate slug on update:', err.message);
      }
    }
    const updatedProduct = await Product.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      product: updatedProduct
    });

  } catch (error) {
    console.error('Update product error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error updating product',
      error: error.message
    });
  }
};

module.exports = { updateProduct };



// Soft delete (archive)
const deleteProduct = async (req, res) => {
  try {
    const id = req.params.id;
    const product = await Product.findByIdAndUpdate(id, { $set: { status: 'archived' } }, { new: true });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    return res.status(200).json({ success: true, message: 'Product archived', product });
  } catch (error) {
    console.error('Delete product error:', error);
    return res.status(500).json({ success: false, message: 'Error archiving product', error: error.message });
  }
};

// Bulk delete (archive multiple)
const bulkDelete = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, message: 'ids array is required' });

    const result = await Product.updateMany({ _id: { $in: ids } }, { $set: { status: 'archived' } });
    return res.status(200).json({ success: true, message: 'Products archived', modifiedCount: result.nModified || result.modifiedCount });
  } catch (error) {
    console.error('Bulk delete error:', error);
    return res.status(500).json({ success: false, message: 'Error archiving products', error: error.message });
  }
};

// Restore archived product
const restoreProduct = async (req, res) => {
  try {
    const id = req.params.id;
    const product = await Product.findByIdAndUpdate(id, { $set: { status: 'active' } }, { new: true });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    return res.status(200).json({ success: true, message: 'Product restored', product });
  } catch (error) {
    console.error('Restore product error:', error);
    return res.status(500).json({ success: false, message: 'Error restoring product', error: error.message });
  }
};

// Get low stock products
const getLowStockProducts = async (req, res) => {
  try {
    const products = await Product.find({
      status: 'active',
      'inventory.trackInventory': true,
      $expr: { $lte: ['$inventory.quantity', '$inventory.lowStockThreshold'] }
    }).sort({ 'inventory.quantity': 1 });

    return res.status(200).json({ success: true, count: products.length, products });
  } catch (error) {
    console.error('Low stock products error:', error);
    return res.status(500).json({ success: false, message: 'Error fetching low stock products', error: error.message });
  }
};

//get all the products
const getAllProducts = async (req, res) => {
  try { 
    const products = await Product.find({ status: 'active' }).populate('category', 'name').sort({ createdAt: -1 });
    return res.status(200).json({ success: true, count: products.length, products });
  } catch (error) {
    console.error('Get all products error:', error);
    return res.status(500).json({ success: false, message: 'Error fetching products', error: error.message });
  } 
};


//get single product by slug
const getProductBySlug = async (req, res) => {
  try {
    const slug = req.params.slug;
    const product = await Product.findOne({ slug, status: 'active' }).populate('category', 'name');
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    return res.status(200).json({ success: true, product });
  }
    catch (error) {
    console.error('Get product by slug error:', error);
    return res.status(500).json({ success: false, message: 'Error fetching product', error: error.message });
  }
};

//get products with only archived status
const getArchivedProducts = async (req, res) => {
    try {
        const products = await Product.find({ status: 'archived' }).populate('category', 'name').sort({ createdAt: -1 });
        return res.status(200).json({ success: true, count: products.length, products });
    } catch (error) {
        console.error('Get archived products error:', error);
        return res.status(500).json({ success: false, message: 'Error fetching archived products', error: error.message });
    }
};


//get products with only draft status
const getDraftProducts = async (req, res) => {
    try {
        const products = await Product.find({ status: 'draft' }).populate('category', 'name').sort({ createdAt: -1 });
        return res.status(200).json({ success: true, count: products.length, products });
    } catch (error) {
        console.error('Get draft products error:', error);
        return res.status(500).json({ success: false, message: 'Error fetching draft products', error: error.message });
    }
};

module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  bulkDelete,
  restoreProduct,
  getLowStockProducts,
  getArchivedProducts,
  getDraftProducts,
  getAllProducts,
  getProductBySlug
};
