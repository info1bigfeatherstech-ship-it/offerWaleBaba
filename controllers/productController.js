const Product = require('../models/Product');
const Category = require('../models/Category');
const mongoose = require('mongoose');
const slugify = require('slugify');
const { generateSlug, generateSku } = require('../utils/productUtils');
const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinaryHelper');
const sharp = require('sharp');
const fs = require('fs');
const csv = require('csv-parser');

// Create new product

const createProduct = async (req, res) => {
  try {
    const {
      name,
      title,
      description,
      category,
      brand,
      price,
      inventory,
      shipping,
      attributes,
      isFeatured,
      status,
      soldInfo,
      fomo
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

    if (!title) {
      return res.status(400).json({
        success: false,
        message: 'Product title is required'
      });
    }

    if (!category) {
      return res.status(400).json({
        success: false,
        message: 'Product category is required'
      });
    }

    // =========================
    // CATEGORY RESOLVE (UNCHANGED)
    // =========================
    const escapeRegExp = (s) =>
      s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    let categoryId;

    if (mongoose.Types.ObjectId.isValid(category)) {
      const found = await Category.findById(category);
      if (!found) {
        return res.status(400).json({
          success: false,
          message: 'Invalid category id'
        });
      }
      categoryId = found._id;
    } else {
      const candidateSlug = slugify(String(category), {
        lower: true,
        strict: true
      });

      let found = await Category.findOne({
        $or: [
          { slug: candidateSlug },
          {
            name: new RegExp(
              '^' + escapeRegExp(String(category)) + '$',
              'i'
            )
          }
        ]
      });

      if (!found) {
        const newCat = new Category({
          name: String(category),
          slug: candidateSlug,
          status: 'active',
          level: 0
        });

        await newCat.save();
        found = newCat;
      }

      categoryId = found._id;
    }

    // =========================
    // Generate Slug & SKU
    // =========================
    const slug = await generateSlug(name);
    const sku = await generateSku();

    // =========================
    // HANDLE PRICE
    // =========================
    let parsedPrice = price;

    if (typeof price === 'string') {
      try {
        parsedPrice = JSON.parse(price);
      } catch {
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
      if (!isNaN(parsedPrice)) {
        priceObj.base = Number(parsedPrice);
      } else if (
        typeof parsedPrice === 'object' &&
        parsedPrice !== null
      ) {
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
        message:
          'Sale start date cannot be after sale end date'
      });
    }

    // =========================
    // INVENTORY (REAL)
    // =========================
    const inventoryObj = {
      quantity: inventory?.quantity || 0,
      trackInventory:
        inventory?.trackInventory !== false,
      lowStockThreshold:
        inventory?.lowStockThreshold || 5
    };

    // =========================
    // SHIPPING
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
    // ATTRIBUTES
    // =========================
    let attributesArr = [];

    if (attributes) {
      let parsedAttributes = attributes;

      if (typeof attributes === 'string') {
        try {
          parsedAttributes = JSON.parse(attributes);
        } catch {
          parsedAttributes = [];
        }
      }

      if (Array.isArray(parsedAttributes)) {
        attributesArr = parsedAttributes.map(
          (attr) => ({
            key: attr.key,
            value: attr.value
          })
        );
      }
    }

    // =========================
    // SOLD INFO (FAKE)
    // =========================
    let soldInfoObj = {
      enabled: false,
      count: 0
    };

    if (soldInfo) {
      let parsedSold = soldInfo;

      if (typeof soldInfo === 'string') {
        try {
          parsedSold = JSON.parse(soldInfo);
        } catch {
          parsedSold = null;
        }
      }

      if (parsedSold) {
        soldInfoObj.enabled =
          parsedSold.enabled === true ||
          parsedSold.enabled === 'true';

        soldInfoObj.count = !isNaN(parsedSold.count)
          ? Number(parsedSold.count)
          : 0;
      }
    }

    // =========================
    // FOMO (FAKE)
    // =========================
    let fomoObj = {
      enabled: false,
      type: 'viewing_now',
      viewingNow: 0,
      productLeft: 0,
      customMessage: ''
    };

    if (fomo) {
      let parsedFomo = fomo;

      if (typeof fomo === 'string') {
        try {
          parsedFomo = JSON.parse(fomo);
        } catch {
          parsedFomo = null;
        }
      }

      if (parsedFomo) {
        fomoObj.enabled =
          parsedFomo.enabled === true ||
          parsedFomo.enabled === 'true';

        if (
          ['viewing_now', 'product_left', 'custom'].includes(
            parsedFomo.type
          )
        ) {
          fomoObj.type = parsedFomo.type;
        }

        fomoObj.viewingNow = !isNaN(
          parsedFomo.viewingNow
        )
          ? Number(parsedFomo.viewingNow)
          : 0;

        fomoObj.productLeft = !isNaN(
          parsedFomo.productLeft
        )
          ? Number(parsedFomo.productLeft)
          : 0;

        fomoObj.customMessage =
          parsedFomo.customMessage || '';
      }
    }

    // =========================
    // IMAGE UPLOAD (UNCHANGED)
    // =========================
    let images = [];

    if (req.files && req.files.length > 0) {
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];

        try {
          const metadata = await sharp(
            file.buffer
          ).metadata();

          if (
            metadata.width > 5000 ||
            metadata.height > 5000
          ) {
            throw new Error(
              'Image dimensions too large'
            );
          }

          const optimizedBuffer = await sharp(
            file.buffer
          )
            .resize({
              width: 1500,
              withoutEnlargement: true
            })
            .webp({ quality: 80 })
            .toBuffer();

          const { url, publicId } =
            await uploadToCloudinary(
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
      title,
      description: description || '',
      category: categoryId,
      brand: brand || 'Generic',
      price: priceObj,
      inventory: inventoryObj,
      shipping: shippingObj,
      images,
      attributes: attributesArr,
      soldInfo: soldInfoObj,
      fomo: fomoObj,
      isFeatured:
        isFeatured === true ||
        isFeatured === 'true',
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

//Bulk create products (for testing)
const bulkCreateProducts = async (req, res) => {
  try {
    const { products } = req.body;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'products array is required'
      });
    }

    const createdProducts = [];
    const failedProducts = [];

    for (let item of products) {
      try {

        // =========================
        // REQUIRED VALIDATION
        // =========================
        if (!item.name || !item.title || !item.category) {
          throw new Error('Missing required fields');
        }

        // =========================
        // CATEGORY RESOLVE
        // =========================
        let categoryId = item.category;

        // (Assuming category id is already valid in bulk import)
        // If needed you can reuse full category resolve logic from createProduct

        // =========================
        // SLUG & SKU
        // =========================
        const slug = await generateSlug(item.name);
        const sku = await generateSku();

        // =========================
        // PRICE (FULL SAFE LOGIC)
        // =========================
        let parsedPrice = item.price || {};

        const priceObj = {
          base: Number(parsedPrice.base || parsedPrice || 0),
          sale: parsedPrice.sale ? Number(parsedPrice.sale) : null,
          costPrice: parsedPrice.costPrice
            ? Number(parsedPrice.costPrice)
            : null,
          saleStartDate: parsedPrice.saleStartDate
            ? new Date(parsedPrice.saleStartDate)
            : null,
          saleEndDate: parsedPrice.saleEndDate
            ? new Date(parsedPrice.saleEndDate)
            : null
        };

        if (priceObj.sale && priceObj.sale >= priceObj.base) {
          throw new Error('Invalid sale price');
        }

        if (
          priceObj.saleStartDate &&
          priceObj.saleEndDate &&
          priceObj.saleStartDate > priceObj.saleEndDate
        ) {
          throw new Error('Invalid sale date range');
        }

        // =========================
        // INVENTORY (REAL)
        // =========================
        const inventoryObj = {
          quantity: Number(item.inventory?.quantity || 0),
          trackInventory:
            item.inventory?.trackInventory !== false,
          lowStockThreshold:
            Number(item.inventory?.lowStockThreshold || 5)
        };

        // =========================
        // SOLD INFO (FAKE)
        // =========================
        const soldInfoObj = {
          enabled: item.soldInfo?.enabled || false,
          count: Number(item.soldInfo?.count || 0)
        };

        // =========================
        // FOMO (FAKE)
        // =========================
        const fomoObj = {
          enabled: item.fomo?.enabled || false,
          type: item.fomo?.type || 'viewing_now',
          viewingNow: Number(item.fomo?.viewingNow || 0),
          productLeft: Number(item.fomo?.productLeft || 0),
          customMessage: item.fomo?.customMessage || ''
        };

        // =========================
        // ATTRIBUTES
        // =========================
        const attributesArr = Array.isArray(item.attributes)
          ? item.attributes.map(attr => ({
              key: attr.key,
              value: attr.value
            }))
          : [];

        // =========================
        // IMAGES (URL BASED)
        // =========================
        const imagesArr = Array.isArray(item.images)
          ? item.images.map((img, index) => ({
              url: img.url,
              publicId: img.publicId || null,
              altText: img.altText || '',
              order: index
            }))
          : [];

        // =========================
        // CREATE PRODUCT
        // =========================
        const product = new Product({
          name: item.name,
          slug,
          sku,
          title: item.title,
          description: item.description || '',
          category: categoryId,
          brand: item.brand || 'Generic',
          price: priceObj,
          inventory: inventoryObj,
          attributes: attributesArr,
          images: imagesArr,
          soldInfo: soldInfoObj,
          fomo: fomoObj,
          status: item.status || 'draft'
        });

        await product.save();
        createdProducts.push(product);

      } catch (err) {
        failedProducts.push({
          name: item.name || 'Unknown',
          error: err.message
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Bulk product creation completed',
      totalRequested: products.length,
      createdCount: createdProducts.length,
      failedCount: failedProducts.length,
      failedProducts
    });

  } catch (error) {
    console.error('Bulk create error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error creating products',
      error: error.message
    });
  }
};



//Bulk create from CSV (for testing)
const importProductsFromCSV = async (req, res) => {
  try {

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'CSV file is required'
      });
    }

    const rows = [];
    const failed = [];
    const validProducts = [];

    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on('data', (row) => {
        rows.push(row);
      })
      .on('end', async () => {

        for (let row of rows) {
          try {

            if (!row.name || !row.title || !row.category) {
              throw new Error('Missing required fields');
            }

            // =========================
            // CATEGORY RESOLVE / AUTO CREATE
            // =========================
            let categoryName = row.category.trim();
            let categorySlug = slugify(categoryName, { lower: true, strict: true });

            let category = await Category.findOne({
              $or: [
                { slug: categorySlug },
                { name: new RegExp(`^${categoryName}$`, 'i') }
              ]
            });

            if (!category) {
              category = await Category.create({
                name: categoryName,
                slug: categorySlug,
                status: 'active',
                level: 0
              });
            }

            // =========================
            // SLUG + SKU
            // =========================
            const slug = slugify(row.name, { lower: true, strict: true }) + '-' + Date.now();
            const sku = 'SKU-' + Math.floor(Math.random() * 1000000);

            // =========================
            // PRICE
            // =========================
            const basePrice = Number(row.basePrice || 0);
            const salePrice = row.salePrice ? Number(row.salePrice) : null;

            if (salePrice && salePrice >= basePrice) {
              throw new Error('Invalid sale price');
            }

            const priceObj = {
              base: basePrice,
              sale: salePrice,
              costPrice: null,
              saleStartDate: null,
              saleEndDate: null
            };

            // =========================
            // INVENTORY
            // =========================
            const inventoryObj = {
              quantity: Number(row.quantity || 0),
              trackInventory: true,
              lowStockThreshold: 5
            };

            // =========================
            // IMAGES (Comma Separated URLs)
            // =========================
            let imagesArr = [];

            if (row.images) {
              const imageUrls = row.images.split(',');

              imagesArr = imageUrls.map((url, index) => ({
                url: url.trim(),
                publicId: null,
                altText: row.name,
                order: index
              }));
            }

            // =========================
            // PRODUCT OBJECT
            // =========================
            validProducts.push({
              name: row.name,
              slug,
              sku,
              title: row.title,
              description: row.description || '',
              category: category._id,
              brand: row.brand || 'Generic',
              price: priceObj,
              inventory: inventoryObj,
              images: imagesArr,
              attributes: [],
              soldInfo: { enabled: false, count: 0 },
              fomo: {
                enabled: false,
                type: 'viewing_now',
                viewingNow: 0,
                productLeft: 0,
                customMessage: ''
              },
              status: 'draft'
            });

          } catch (err) {
            failed.push({
              product: row.name || 'Unknown',
              error: err.message
            });
          }
        }

        // =========================
        // BULK INSERT
        // =========================
        const inserted = await Product.insertMany(validProducts);

        fs.unlinkSync(req.file.path); // delete uploaded file

        return res.status(200).json({
          success: true,
          totalRows: rows.length,
          insertedCount: inserted.length,
          failedCount: failed.length,
          failed
        });

      });

  } catch (error) {
    console.error('CSV import error:', error);
    return res.status(500).json({
      success: false,
      message: 'CSV import failed',
      error: error.message
    });
  }
};



//Update existing product
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
    // 1️⃣ HANDLE PRICE
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

        if (
          updates.price.sale &&
          updates.price.sale >= updates.price.base
        ) {
          return res.status(400).json({
            success: false,
            message: 'Sale price must be less than base price'
          });
        }

        if (
          updates.price.saleStartDate &&
          updates.price.saleEndDate &&
          new Date(updates.price.saleStartDate) >
            new Date(updates.price.saleEndDate)
        ) {
          return res.status(400).json({
            success: false,
            message:
              'Sale start date cannot be after sale end date'
          });
        }
      }
    }

    // ===================================================
    // 2️⃣ HANDLE INVENTORY (REAL)
    // ===================================================
    if (updates.inventory) {
      let parsedInventory = updates.inventory;

      if (typeof parsedInventory === 'string') {
        try {
          parsedInventory = JSON.parse(parsedInventory);
        } catch {
          parsedInventory = {};
        }
      }

      updates.inventory = {
        ...existingProduct.inventory.toObject(),
        ...parsedInventory
      };

      if (!isNaN(updates.inventory.quantity)) {
        updates.inventory.quantity = Number(updates.inventory.quantity);
      }

      if (!isNaN(updates.inventory.lowStockThreshold)) {
        updates.inventory.lowStockThreshold = Number(
          updates.inventory.lowStockThreshold
        );
      }
    }

    // ===================================================
    // 3️⃣ HANDLE ATTRIBUTES
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
    // 4️⃣ HANDLE SOLD INFO (FAKE)
    // ===================================================
    if (updates.soldInfo) {
      let parsedSold = updates.soldInfo;

      if (typeof parsedSold === 'string') {
        try {
          parsedSold = JSON.parse(parsedSold);
        } catch {
          parsedSold = {};
        }
      }

      updates.soldInfo = {
        ...existingProduct.soldInfo.toObject(),
        ...parsedSold
      };

      updates.soldInfo.enabled =
        updates.soldInfo.enabled === true ||
        updates.soldInfo.enabled === 'true';

      if (!isNaN(updates.soldInfo.count)) {
        updates.soldInfo.count = Number(updates.soldInfo.count);
      }
    }

    // ===================================================
    // 5️⃣ HANDLE FOMO (FAKE STRUCTURED)
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

      updates.fomo = {
        ...existingProduct.fomo.toObject(),
        ...parsedFomo
      };

      updates.fomo.enabled =
        updates.fomo.enabled === true ||
        updates.fomo.enabled === 'true';

      if (!isNaN(updates.fomo.viewingNow)) {
        updates.fomo.viewingNow = Number(updates.fomo.viewingNow);
      }

      if (!isNaN(updates.fomo.productLeft)) {
        updates.fomo.productLeft = Number(updates.fomo.productLeft);
      }

      if (
        !['viewing_now', 'product_left', 'custom'].includes(
          updates.fomo.type
        )
      ) {
        updates.fomo.type = existingProduct.fomo.type;
      }
    }

    // ===================================================
    // 6️⃣ HANDLE IMAGE DELETION
    // ===================================================
    if (Array.isArray(updates.images)) {
      const existingPublicIds = existingProduct.images.map(
        img => img.publicId
      );

      const updatedPublicIds = updates.images.map(
        img => img.publicId
      );

      const removedImages = existingPublicIds.filter(
        id => !updatedPublicIds.includes(id)
      );

      for (const publicId of removedImages) {
        await deleteFromCloudinary(publicId);
      }
    }

    // ===================================================
    // 7️⃣ HANDLE NEW IMAGE UPLOAD
    // ===================================================
    if (req.files && req.files.length > 0) {
      const newImages = [];

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];

        try {
          const optimizedBuffer = await sharp(file.buffer)
            .resize({ width: 1500, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();

          const { url, publicId } =
            await uploadToCloudinary(
              optimizedBuffer,
              `products/${existingProduct.slug}`
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
          console.error(`Image ${i} failed:`, err.message);
        }
      }

      updates.images = [
        ...(updates.images || existingProduct.images),
        ...newImages
      ];
    }

    // ===================================================
    // 8️⃣ Normalize Image Order
    // ===================================================
    if (Array.isArray(updates.images)) {
      updates.images = updates.images.map((img, index) => ({
        ...img,
        order:
          typeof img.order === 'number'
            ? img.order
            : index
      }));
    }

    // ===================================================
    // 9️⃣ Regenerate Slug if Name Changed
    // ===================================================
    if (
      updates.name &&
      updates.name !== existingProduct.name
    ) {
      updates.slug = await generateSlug(
        updates.name,
        existingProduct._id
      );
    }

    // ===================================================
    // 🔟 UPDATE PRODUCT
    // ===================================================
    const updatedProduct = await Product.findByIdAndUpdate(
      existingProduct._id,
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
    
   

// Soft delete (archive)
const deleteProduct = async (req, res) => {
  try {
    const { slug } = req.params;

    const product = await Product.findOne({
      slug
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (product.status === 'archived') {
      return res.status(400).json({
        success: false,
        message: 'Product already archived'
      });
    }

    product.status = 'archived';
    await product.save();

    return res.status(200).json({
      success: true,
      message: 'Product archived successfully',
      product
    });

  } catch (error) {
    console.error('Delete product error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error archiving product',
      error: error.message
    });
  }
};

// Bulk delete (archive multiple)
const bulkDelete = async (req, res) => {
  try {
    const { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'slugs array is required'
      });
    }

    const result = await Product.updateMany(
      {
        slug: { $in: slugs },
        status: { $ne: 'archived' } // prevent re-archiving
      },
      {
        $set: {
          status: 'archived',
          archivedAt: new Date() // optional but recommended
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: 'Products archived successfully',
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount
    });

  } catch (error) {
    console.error('Bulk delete error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error archiving products',
      error: error.message
    });
  }
};

// Restore archived product
const restoreProduct = async (req, res) => {
  try {
    const { slug } = req.params;

    const product = await Product.findOne({ slug });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (product.status !== 'archived') {
      return res.status(400).json({
        success: false,
        message: 'Product is not archived'
      });
    }

    product.status = 'active'; // or 'draft' depending on your logic
    product.archivedAt = null; // if field exists

    await product.save();

    return res.status(200).json({
      success: true,
      message: 'Product restored successfully',
      product
    });

  } catch (error) {
    console.error('Restore product error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error restoring product',
      error: error.message
    });
  }
};


// Bulk restore archived products
const bulkRestore = async (req, res) => {
  try {
    const { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'slugs array is required'
      });
    }

    const result = await Product.updateMany(
      {
        slug: { $in: slugs },
        status: 'archived' // only restore archived
      },
      {
        $set: {
          status: 'active', // or 'draft' depending on your logic
          archivedAt: null
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: 'Products restored successfully',
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount
    });

  } catch (error) {
    console.error('Bulk restore error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error restoring products',
      error: error.message
    });
  }
};




// Get low stock products
const getLowStockProducts = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const skip = (page - 1) * limit;

    const query = {
      status: 'active',
      'inventory.trackInventory': true,
      'inventory.quantity': { $gt: 0 }, // exclude out of stock
      $expr: {
        $lte: [
          '$inventory.quantity',
          '$inventory.lowStockThreshold'
        ]
      }
    };

    const [products, total] = await Promise.all([
      Product.find(query)
        .select('name slug inventory price images , soldInfo , fomo')
        .sort({ 'inventory.quantity': 1 })
        .skip(skip)
        .limit(Number(limit)),

      Product.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: Number(page),
      limit: Number(limit),
      count: products.length,
      products
    });

  } catch (error) {
    console.error('Low stock products error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching low stock products',
      error: error.message
    });
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
        const products = await Product.find({ status: { $regex: '^archived$', $options: 'i' } }).populate('category', 'name').sort({ createdAt: -1 });
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

// Permanently delete product (only if archived)
const hardDeleteProduct = async (req, res) => {
  try {
    const { slug } = req.params;

    const product = await Product.findOne({ slug });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // 🔒 Safety check: only allow delete if archived
    if (product.status !== 'archived') {
      return res.status(400).json({
        success: false,
        message: 'Only archived products can be permanently deleted'
      });
    }

    // ===================================================
    // 1️⃣ Delete images from Cloudinary
    // ===================================================
    if (product.images && product.images.length > 0) {
      for (const img of product.images) {
        if (img.publicId) {
          await deleteFromCloudinary(img.publicId);
        }
      }
    }

    // ===================================================
    // 2️⃣ Delete product from DB
    // ===================================================
    await Product.deleteOne({ _id: product._id });

    return res.status(200).json({
      success: true,
      message: 'Product permanently deleted'
    });

  } catch (error) {
    console.error('Hard delete product error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error permanently deleting product',
      error: error.message
    });
  }
};

// Bulk hard delete (permanently delete multiple archived products)
const bulkHardDelete = async (req, res) => {
  try {
    const { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'slugs array is required'
      });
    }

    // ===================================================
    // 1️⃣ Fetch only archived products
    // ===================================================
    const products = await Product.find({
      slug: { $in: slugs },
      status: 'archived'
    });

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No archived products found to delete'
      });
    }

    const productIds = products.map(p => p._id);

    // ===================================================
    // 2️⃣ Delete Cloudinary images
    // ===================================================
    for (const product of products) {
      if (product.images && product.images.length > 0) {
        for (const img of product.images) {
          if (img.publicId) {
            await deleteFromCloudinary(img.publicId);
          }
        }
      }
    }

    // ===================================================
    // 3️⃣ Delete from DB
    // ===================================================
    const deleteResult = await Product.deleteMany({
      _id: { $in: productIds }
    });

    return res.status(200).json({
      success: true,
      message: 'Products permanently deleted',
      requested: slugs.length,
      deletedCount: deleteResult.deletedCount,
      skipped: slugs.length - deleteResult.deletedCount
    });

  } catch (error) {
    console.error('Bulk hard delete error:', error);
    return res.status(500).json({
      success: false,
      message: 'Error permanently deleting products',
      error: error.message
    });
  }
};



module.exports = {
  createProduct,
  updateProduct,
  deleteProduct,
  bulkDelete,
  hardDeleteProduct,
  bulkHardDelete,
  restoreProduct,
  getLowStockProducts,
  getArchivedProducts,
  getDraftProducts,
  getAllProducts,
  getProductBySlug , 
   bulkCreateProducts ,
    bulkRestore  , 
    importProductsFromCSV 
};
