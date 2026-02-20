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
      status,
       fomo   // ✅ NEW FOMO field
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
// HANDLE FOMO (FIXED VERSION)
// =========================
let fomoObj = {
  enabled: false,
  type: 'sold_count',
  value: 0,
  message: ''
};

let parsedFomo = null;

// If coming from raw JSON
if (req.body.fomo && typeof req.body.fomo === 'object') {
  parsedFomo = req.body.fomo;
}

// If coming from form-data (stringified)
if (req.body.fomo && typeof req.body.fomo === 'string') {
  try {
    parsedFomo = JSON.parse(req.body.fomo);
  } catch {
    parsedFomo = null;
  }
}

if (parsedFomo) {
  fomoObj.enabled =
    parsedFomo.enabled === true ||
    parsedFomo.enabled === 'true';

  if (
    ['sold_count', 'viewing_now', 'custom_message'].includes(parsedFomo.type)
  ) {
    fomoObj.type = parsedFomo.type;
  }

  if (!isNaN(parsedFomo.value)) {
    fomoObj.value = Number(parsedFomo.value);
  }

  if (parsedFomo.type === 'custom_message') {
    fomoObj.message = parsedFomo.message || '';
  }
}

   
   // =========================
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
      fomo: fomoObj,   // ✅ ADD THIS LINE
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
    const slug = req.params.slug;

    const existingProduct = await Product.findOne({ slug });
    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const updates = { ...req.body };

    // ❌ Prevent manual slug & sku change
    delete updates.slug;
    delete updates.sku;

    // ===================================================
    // 1️⃣ HANDLE PRICE (object safe)
    // ===================================================
    if (updates.price) {
      let parsedPrice = updates.price;

      if (typeof parsedPrice === 'string') {
        try {
          parsedPrice = JSON.parse(parsedPrice);
        } catch {
          parsedPrice = {};
        }
      }

      if (typeof parsedPrice === 'object') {
        updates.price = {
          ...existingProduct.price.toObject(),
          ...parsedPrice
        };

        if (updates.price.sale && updates.price.sale >= updates.price.base) {
          return res.status(400).json({
            success: false,
            message: 'Sale price must be less than base price'
          });
        }
      }
    }

    // ===================================================
    // 2️⃣ HANDLE ATTRIBUTES
    // ===================================================
    if (updates.attributes) {
      let parsedAttributes = updates.attributes;

      if (typeof parsedAttributes === 'string') {
        try {
          parsedAttributes = JSON.parse(parsedAttributes);
        } catch {
          parsedAttributes = [];
        }
      }

      if (Array.isArray(parsedAttributes)) {
        updates.attributes = parsedAttributes.map(attr => ({
          key: attr.key,
          value: attr.value
        }));
      }
    }

    // ===================================================
    // 3️⃣ HANDLE FOMO (IMPORTANT)
    // ===================================================
    if (updates.fomo) {
      let parsedFomo = updates.fomo;

      if (typeof parsedFomo === 'string') {
        try {
          parsedFomo = JSON.parse(parsedFomo);
        } catch {
          parsedFomo = {};
        }
      }

      if (typeof parsedFomo === 'object') {
        updates.fomo = {
          ...existingProduct.fomo.toObject(),
          ...parsedFomo
        };

        if (!isNaN(updates.fomo.value)) {
          updates.fomo.value = Number(updates.fomo.value);
        }

        updates.fomo.enabled =
          updates.fomo.enabled === true ||
          updates.fomo.enabled === 'true';
      }
    }

    // ===================================================
    // 4️⃣ HANDLE IMAGE DELETION
    // ===================================================
    if (Array.isArray(updates.images)) {

      const existingPublicIds = existingProduct.images.map(img => img.publicId);
      const updatedPublicIds = updates.images.map(img => img.publicId);

      const removedImages = existingPublicIds.filter(
        id => !updatedPublicIds.includes(id)
      );

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
          const metadata = await sharp(file.buffer).metadata();

          if (metadata.width > 5000 || metadata.height > 5000) {
            throw new Error('Image dimensions too large (max 5000px)');
          }

          const optimizedBuffer = await sharp(file.buffer)
            .resize({ width: 1500, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();

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
    // 7️⃣ Regenerate slug if name changed
    // ===================================================
    if (updates.name && updates.name !== existingProduct.name) {
      updates.slug = await generateSlug(updates.name, id);
    }

    // ===================================================
    // 8️⃣ UPDATE PRODUCT
    // ===================================================
    const updatedProduct = await Product.findOneAndUpdate(
      { slug: slug },
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
    const slug = req.params.slug;
    const product = await Product.findOneAndUpdate({ slug }, { $set: { status: 'archived' } }, { new: true });
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
    const { slugs } = req.body;
    if (!Array.isArray(slugs) || slugs.length === 0) return res.status(400).json({ success: false, message: 'slugs array is required' });

    const result = await Product.updateMany({ slug: { $in: slugs } }, { $set: { status: 'archived' } });
    return res.status(200).json({ success: true, message: 'Products archived', modifiedCount: result.nModified || result.modifiedCount });
  } catch (error) {
    console.error('Bulk delete error:', error);
    return res.status(500).json({ success: false, message: 'Error archiving products', error: error.message });
  }
};

// Restore archived product
const restoreProduct = async (req, res) => {
  try {
    const slug = req.params.slug;
    const product = await Product.findOneAndUpdate({ slug }, { $set: { status: 'active' } }, { new: true });
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
    console.log(`fetched product ${slug}`);
    
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
