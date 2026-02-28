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
  status,
  isFeatured,
  soldInfo,
  fomo,
  shipping,
  attributes,
  variants: variantsRaw
} = req.body;

    if (!name || !title || !category) {
      return res.status(400).json({
        success: false,
        message: "Name, title and category are required"
      });
    }
   // ✅ ADD THIS BLOCK HERE
if (!mongoose.Types.ObjectId.isValid(category)) {
  return res.status(400).json({
    success: false,
    message: "Invalid category ID format"
  });
}

const existingCategory = await Category.findById(category);

if (!existingCategory) {
  return res.status(400).json({
    success: false,
    message: "Selected category does not exist. Please select a valid category."
  });
}
    // Parse variants JSON (important for form-data)
    let variantsInput = variantsRaw;
    if (typeof variantsRaw === "string") {
      variantsInput = JSON.parse(variantsRaw);
    }

    if (!Array.isArray(variantsInput) || variantsInput.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one variant is required"
      });
    }

    const slug = await generateSlug(name);

    const variants = [];

    // Group uploaded files by variant index
    const filesByVariant = {};

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const match = file.fieldname.match(/^variantImages_(\d+)$/);
        if (match) {
          const index = Number(match[1]);
          if (!filesByVariant[index]) {
            filesByVariant[index] = [];
          }
          filesByVariant[index].push(file);
        }
      }
    }

    // Validate max images per variant (5)
    for (const idxStr of Object.keys(filesByVariant)) {
      const idx = Number(idxStr);
      if (filesByVariant[idx] && filesByVariant[idx].length > 5) {
        return res.status(400).json({
          success: false,
          message: `Variant ${idx} can have at most 5 images`
        });
      }
    }

    // Process each variant
    for (let i = 0; i < variantsInput.length; i++) {
      const v = variantsInput[i];

      const priceObj = {
        base: Number(v.price?.base) || 0,
        sale: v.price?.sale != null ? Number(v.price.sale) : null
      };

      if (priceObj.sale != null && priceObj.sale >= priceObj.base) {
        return res.status(400).json({
          success: false,
          message: `Sale price must be less than base price for variant ${i}`
        });
      }

      const inventoryObj = {
        quantity: Number(v.inventory?.quantity) || 0,
        trackInventory: v.inventory?.trackInventory !== false,
        lowStockThreshold: v.inventory?.lowStockThreshold || 5
      };

      const skuVal = v.sku
        ? String(v.sku).toUpperCase()
        : `${slug}-VAR${i + 1}`.toUpperCase();

      // Upload images for this variant
      const variantImages = [];

      if (filesByVariant[i]) {
        for (let imgIndex = 0; imgIndex < filesByVariant[i].length; imgIndex++) {
          const file = filesByVariant[i][imgIndex];

          const optimizedBuffer = await sharp(file.buffer)
            .resize({ width: 1500, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();

          const publicIdName = `${slug}_${skuVal}_img${imgIndex + 1}_${Date.now()}`;

          const { url, publicId } = await uploadToCloudinary(
            optimizedBuffer,
            `products/${slug}`,
            publicIdName
          );

          variantImages.push({
            url,
            publicId,
            altText: `${name} ${skuVal} image ${imgIndex + 1}`,
            order: imgIndex
          });
        }
      }

      variants.push({
        sku: skuVal,
        attributes: Array.isArray(v.attributes)
          ? v.attributes.map(a => ({ key: a.key, value: a.value }))
          : [],
        price: priceObj,
        inventory: inventoryObj,
        images: variantImages,
        isActive: v.isActive !== false
      });
    }

    // Calculate price range
    const effectivePrices = variants.map(v =>
      v.price.sale != null ? v.price.sale : v.price.base
    );

    const minPrice = Math.min(...effectivePrices);
    const maxPrice = Math.max(...effectivePrices);

    const totalStock = variants.reduce(
      (sum, v) => sum + (v.inventory.quantity || 0),
      0
    );


let parsedSoldInfo = soldInfo;
let parsedFomo = fomo;
let parsedShipping = shipping;
let parsedAttributes = attributes;


try {
  if (typeof soldInfo === "string") {
    parsedSoldInfo = JSON.parse(soldInfo);
  }
  if (typeof fomo === "string") {
    parsedFomo = JSON.parse(fomo);
  }
  if (typeof shipping === "string") {
    parsedShipping = JSON.parse(shipping);
  }
  if (typeof attributes === "string") {
    parsedAttributes = JSON.parse(attributes);
  }
} catch (err) {
  return res.status(400).json({
    success: false,
    message: "Invalid JSON format in request body"
  });
}


    const product = new Product({
  name,
  slug,
  title,
  description: description || "",
  category:existingCategory._id,
  brand: brand || "Generic",
  variants,
  priceRange: {
    min: minPrice,
    max: maxPrice
  },
  totalStock,

  // ADD THESE 👇
  isFeatured: isFeatured || false,
soldInfo: parsedSoldInfo || { enabled: false, count: 0 },
  fomo: parsedFomo || { enabled: false, type: "viewing_now", viewingNow: 0 },
  shipping: parsedShipping || {
    weight: 0,
    dimensions: { length: 0, width: 0, height: 0 }
  },
  attributes: parsedAttributes || [],

  status: status || "draft"
});

    await product.save();

    return res.status(201).json({
      success: true,
      message: "Product created successfully",
      product,
      "categoryDetails": existingCategory.name
    });

  } catch (error) {
    console.error("Create product error:", error);
    return res.status(500).json({
      success: false,
      message: "Error creating product",
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
        message: "products array is required"
      });
    }

    const createdProducts = [];
    const failedProducts = [];

    for (let item of products) {
      try {
        if (!item.name || !item.title || !item.category) {
          throw new Error("Missing required fields");
        }

        const slug = await generateSlug(item.name);

        // =========================
        // PARSE NESTED OBJECTS (SAFE)
        // =========================
        const parseIfString = (value) => {
          if (typeof value === "string") {
            try {
              return JSON.parse(value);
            } catch {
              return value;
            }
          }
          return value;
        };

        const soldInfoInput = parseIfString(item.soldInfo) || {};
        const fomoInput = parseIfString(item.fomo) || {};
        const shippingInput = parseIfString(item.shipping) || {};
        const attributesInput = parseIfString(item.attributes) || [];
        const variantsInput = parseIfString(item.variants);

        // =========================
        // VARIANTS (SUPPORT BOTH TYPES)
        // =========================
        let variants = [];

        if (Array.isArray(variantsInput) && variantsInput.length > 0) {
          variants = variantsInput.map((v, index) => {
            const basePrice = Number(v.price?.base || 0);
            const salePrice =
              v.price?.sale != null ? Number(v.price.sale) : null;

            if (salePrice && salePrice >= basePrice) {
              throw new Error("Invalid sale price");
            }

            return {
              sku: v.sku
                ? String(v.sku).toUpperCase()
                : `${slug}-VAR${index + 1}`.toUpperCase(),
              attributes: Array.isArray(v.attributes)
                ? v.attributes.map(a => ({
                    key: a.key,
                    value: a.value
                  }))
                : [],
              price: {
                base: basePrice,
                sale: salePrice
              },
              inventory: {
                quantity: Number(v.inventory?.quantity ?? 0),
                trackInventory: v.inventory?.trackInventory ?? true,
                lowStockThreshold:
                  Number(v.inventory?.lowStockThreshold ?? 5)
              },
              images: [],
              isActive: v.isActive ?? true
            };
          });
        } else {
          // If no variants provided, create single variant
          const basePrice = Number(item.price?.base || item.price || 0);

          variants.push({
            sku: `${slug}-VAR1`.toUpperCase(),
            attributes: [],
            price: { base: basePrice, sale: null },
            inventory: {
              quantity: Number(item.inventory?.quantity ?? 0),
              trackInventory: item.inventory?.trackInventory ?? true,
              lowStockThreshold:
                Number(item.inventory?.lowStockThreshold ?? 5)
            },
            images: [],
            isActive: true
          });
        }

        // =========================
        // CALCULATE PRICE RANGE
        // =========================
        const effectivePrices = variants.map(v =>
          v.price.sale != null ? v.price.sale : v.price.base
        );

        const minPrice = Math.min(...effectivePrices);
        const maxPrice = Math.max(...effectivePrices);

        const totalStock = variants.reduce(
          (sum, v) => sum + (v.inventory.quantity || 0),
          0
        );

        // =========================
        // CREATE PRODUCT
        // =========================
        const product = new Product({
          name: item.name,
          slug,
          title: item.title,
          description: item.description || "",
          category: item.category,
          brand: item.brand || "Generic",

          variants,
          priceRange: {
            min: minPrice,
            max: maxPrice
          },
          totalStock,

          soldInfo: {
            enabled: soldInfoInput.enabled ?? false,
            count: Number(soldInfoInput.count ?? 0)
          },

          fomo: {
            enabled: fomoInput.enabled ?? false,
            type: fomoInput.type || "viewing_now",
            viewingNow: Number(fomoInput.viewingNow ?? 0),
            productLeft: Number(fomoInput.productLeft ?? 0),
            customMessage: fomoInput.customMessage || ""
          },

          shipping: {
            weight: Number(shippingInput.weight ?? 0),
            dimensions: {
              length: Number(shippingInput.dimensions?.length ?? 0),
              width: Number(shippingInput.dimensions?.width ?? 0),
              height: Number(shippingInput.dimensions?.height ?? 0)
            }
          },

          attributes: Array.isArray(attributesInput)
            ? attributesInput.map(attr => ({
                key: attr.key,
                value: attr.value
              }))
            : [],

          isFeatured: item.isFeatured ?? false,
          status: item.status || "draft"
        });

        await product.save();
        createdProducts.push(product);

      } catch (err) {
        failedProducts.push({
          name: item.name || "Unknown",
          error: err.message
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: "Bulk product creation completed",
      totalRequested: products.length,
      createdCount: createdProducts.length,
      failedCount: failedProducts.length,
      failedProducts
    });

  } catch (error) {
    console.error("Bulk create error:", error);
    return res.status(500).json({
      success: false,
      message: "Error creating products",
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
        message: "Product not found"
      });
    }

    const updates = { ...req.body };

    delete updates.slug;
    delete updates.sku;

    const singleVariant =
      existingProduct.variants &&
      existingProduct.variants.length === 1
        ? existingProduct.variants[0]
        : null;

    const parseIfString = (value, fallback) => {
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return fallback;
        }
      }
      return value;
    };

    // =========================
    // PRICE (single variant compatibility)
    // =========================
    if (updates.price && singleVariant) {
      const parsedPrice = parseIfString(updates.price, {});
      const mergedPrice = {
        ...singleVariant.price.toObject(),
        ...parsedPrice
      };

      if (
        mergedPrice.sale &&
        mergedPrice.sale >= mergedPrice.base
      ) {
        return res.status(400).json({
          success: false,
          message: "Sale price must be less than base price"
        });
      }

      updates["variants.0.price"] = mergedPrice;
      delete updates.price;
    }



    
    // =========================
    // INVENTORY (single variant compatibility)
    // =========================
    if (updates.inventory && singleVariant) {
      const parsedInventory = parseIfString(
        updates.inventory,
        {}
      );

      const mergedInventory = {
        ...singleVariant.inventory.toObject(),
        ...parsedInventory
      };

      mergedInventory.quantity = Number(
        mergedInventory.quantity ?? 0
      );
      mergedInventory.lowStockThreshold = Number(
        mergedInventory.lowStockThreshold ?? 5
      );

      updates["variants.0.inventory"] = mergedInventory;
      delete updates.inventory;
    }

    // =========================
    // SOLD INFO
    // =========================
    if (updates.soldInfo) {
      const parsed = parseIfString(updates.soldInfo, {});
      updates.soldInfo = {
        ...existingProduct.soldInfo.toObject(),
        ...parsed,
        enabled:
          parsed.enabled === true ||
          parsed.enabled === "true",
        count: Number(parsed.count ?? 0)
      };
    }

    // =========================
    // FOMO
    // =========================
    if (updates.fomo) {
      const parsed = parseIfString(updates.fomo, {});
      updates.fomo = {
        ...existingProduct.fomo.toObject(),
        ...parsed,
        enabled:
          parsed.enabled === true ||
          parsed.enabled === "true",
        viewingNow: Number(parsed.viewingNow ?? 0),
        productLeft: Number(parsed.productLeft ?? 0),
        type: ["viewing_now", "product_left", "custom"].includes(
          parsed.type
        )
          ? parsed.type
          : existingProduct.fomo.type
      };
    }

    // =========================
    // SHIPPING
    // =========================
    if (updates.shipping) {
      const parsed = parseIfString(updates.shipping, {});
      updates.shipping = {
        ...existingProduct.shipping.toObject(),
        ...parsed,
        weight: Number(parsed.weight ?? 0),
        dimensions: {
          length: Number(parsed.dimensions?.length ?? 0),
          width: Number(parsed.dimensions?.width ?? 0),
          height: Number(parsed.dimensions?.height ?? 0)
        }
      };
    }

    // =========================
    // ATTRIBUTES
    // =========================
    if (updates.attributes) {
      const parsed = parseIfString(updates.attributes, []);
      updates.attributes = Array.isArray(parsed)
        ? parsed.map(a => ({
            key: a.key,
            value: a.value
          }))
        : [];
    }

    // =========================
    // FULL VARIANT REPLACEMENT
    // =========================
    if (updates.variants) {
      const parsedVariants = parseIfString(
        updates.variants,
        []
      );

      if (Array.isArray(parsedVariants)) {
        updates.variants = parsedVariants.map(v => ({
          ...v,
          price: {
            base: Number(v.price?.base ?? 0),
            sale:
              v.price?.sale != null
                ? Number(v.price.sale)
                : null
          },
          inventory: {
            quantity: Number(v.inventory?.quantity ?? 0),
            trackInventory:
              v.inventory?.trackInventory ?? true,
            lowStockThreshold:
              Number(v.inventory?.lowStockThreshold ?? 5)
          }
        }));
      }
    }

    // =========================
    // Slug regeneration
    // =========================
    if (
      updates.name &&
      updates.name !== existingProduct.name
    ) {
      updates.slug = await generateSlug(
        updates.name,
        existingProduct._id
      );
    }

    // =========================
    // UPDATE
    // =========================
    const updatedProduct = await Product.findByIdAndUpdate(
      existingProduct._id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    // =========================
    // RECALCULATE priceRange & totalStock
    // =========================
    const effectivePrices = updatedProduct.variants.map(v =>
      v.price.sale != null ? v.price.sale : v.price.base
    );

    updatedProduct.priceRange = {
      min: Math.min(...effectivePrices),
      max: Math.max(...effectivePrices)
    };

    updatedProduct.totalStock =
      updatedProduct.variants.reduce(
        (sum, v) => sum + (v.inventory.quantity || 0),
        0
      );

      // =========================
// HANDLE VARIANT IMAGE UPLOADS
// =========================
if (req.files && req.files.length > 0) {

  const filesByVariant = {};

  for (const file of req.files) {
    const match = file.fieldname.match(/^variantImages_(\d+)$/);
    if (match) {
      const index = Number(match[1]);
      if (!filesByVariant[index]) {
        filesByVariant[index] = [];
      }
      filesByVariant[index].push(file);
    }
  }

  for (const indexStr of Object.keys(filesByVariant)) {
    const index = Number(indexStr);

    if (!updatedProduct.variants[index]) continue;

    const variant = updatedProduct.variants[index];

    // max 5 images rule
    if (variant.images.length + filesByVariant[index].length > 5) {
      return res.status(400).json({
        success: false,
        message: `Variant ${index} can have maximum 5 images`
      });
    }

    for (let i = 0; i < filesByVariant[index].length; i++) {
      const file = filesByVariant[index][i];

      const optimizedBuffer = await sharp(file.buffer)
        .resize({ width: 1500, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      const publicIdName = `${updatedProduct.slug}_${variant.sku}_${Date.now()}_${i}`;

      const { url, publicId } = await uploadToCloudinary(
        optimizedBuffer,
        `products/${updatedProduct.slug}`,
        publicIdName
      );

      variant.images.push({
        url,
        publicId,
        altText: `${updatedProduct.name} ${variant.sku}`,
        order: variant.images.length
      });
    }
  }

  // await updatedProduct.save();
}

    await updatedProduct.save();

    return res.status(200).json({
      success: true,
      message: "Product updated successfully",
      product: updatedProduct
    });

  } catch (error) {
    console.error("Update product error:", error);
    return res.status(500).json({
      success: false,
      message: "Error updating product",
      error: error.message
    });
  }
};
    
   

// Soft delete (archive)
// Soft delete (archive)
const deleteProduct = async (req, res) => {
  try {
    const { slug } = req.params;

    const product = await Product.findOneAndUpdate(
      { slug, status: { $ne: "archived" } },
      { 
        $set: { 
          status: "archived",
          // archivedAt: new Date()
        } 
      },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found or already archived"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Product archived successfully",
      product
    });

  } catch (error) {
    console.error("Archive product error:", error);
    return res.status(500).json({
      success: false,
      message: "Error archiving product",
      error: error.message
    });
  }
};

// Bulk delete (archive multiple)
// Bulk archive products
const bulkDelete = async (req, res) => {
  try {
    let { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "slugs array is required"
      });
    }

    // Sanitize slugs (remove invalid values)
    slugs = slugs
      .filter(slug => typeof slug === "string" && slug.trim() !== "")
      .map(slug => slug.trim());

    if (slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid slugs provided"
      });
    }

    // Optional: Protect from huge requests
    if (slugs.length > 500) {
      return res.status(400).json({
        success: false,
        message: "Maximum 500 products allowed per request"
      });
    }

    const result = await Product.updateMany(
      {
        slug: { $in: slugs },
        status: { $ne: "archived" }
      },
      {
        $set: {
          status: "archived",
          archivedAt: new Date()
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: "Bulk archive completed",
      requested: slugs.length,
      archived: result.modifiedCount,
      skipped: slugs.length - result.modifiedCount
    });

  } catch (error) {
    console.error("Bulk archive error:", error);
    return res.status(500).json({
      success: false,
      message: "Error archiving products",
      error: error.message
    });
  }
};

// Restore archived product
// Restore archived product
const restoreProduct = async (req, res) => {
  try {
    const { slug } = req.params;

    const product = await Product.findOneAndUpdate(
      { slug, status: "archived" },
      {
        $set: { status: "active" }, // or your default restore status
        $unset: { archivedAt: "" }
      },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Archived product not found"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Product restored successfully",
      product
    });

  } catch (error) {
    console.error("Restore product error:", error);
    return res.status(500).json({
      success: false,
      message: "Error restoring product",
      error: error.message
    });
  }
};


// Bulk restore archived products
// Bulk restore archived products
const bulkRestore = async (req, res) => {
  try {
    let { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "slugs array is required"
      });
    }

    // Sanitize slugs
    slugs = slugs
      .filter(slug => typeof slug === "string" && slug.trim() !== "")
      .map(slug => slug.trim());

    if (slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid slugs provided"
      });
    }

    // Optional protection
    if (slugs.length > 500) {
      return res.status(400).json({
        success: false,
        message: "Maximum 500 products allowed per request"
      });
    }

    const result = await Product.updateMany(
      {
        slug: { $in: slugs },
        status: "archived"
      },
      {
        $set: { status: "active" }, // or your default restore status
        $unset: { archivedAt: "" }
      }
    );

    return res.status(200).json({
      success: true,
      message: "Bulk restore completed",
      requested: slugs.length,
      restored: result.modifiedCount,
      skipped: slugs.length - result.modifiedCount
    });

  } catch (error) {
    console.error("Bulk restore error:", error);
    return res.status(500).json({
      success: false,
      message: "Error restoring products",
      error: error.message
    });
  }
};




// Get low stock products
// Get low stock products
const getLowStockProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;

    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(100, Number(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const query = {
      status: "active",
      $expr: {
        $anyElementTrue: {
          $map: {
            input: "$variants",
            as: "variant",
            in: {
              $and: [
                { $eq: ["$$variant.inventory.trackInventory", true] },
                { $gt: ["$$variant.inventory.quantity", 0] },
                {
                  $lte: [
                    "$$variant.inventory.quantity",
                    "$$variant.inventory.lowStockThreshold"
                  ]
                }
              ]
            }
          }
        }
      }
    };

    const [products, total] = await Promise.all([
      Product.find(query)
        .select("name slug variants price images")
        .sort({ "variants.inventory.quantity": 1 })
        .skip(skip)
        .limit(limitNumber),

      Product.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: pageNumber,
      limit: limitNumber,
      count: products.length,
      products
    });

  } catch (error) {
    console.error("Low stock products error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching low stock products",
      error: error.message
    });
  }
};

//get all the products
// Get all active products (paginated)
const getAllProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;

    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(100, Number(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const query = { status: "active" };

    const [products, total] = await Promise.all([
      Product.find(query)
        .select("name slug price images category createdAt")
        .populate("category", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),

      Product.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: pageNumber,
      limit: limitNumber,
      count: products.length,
      products
    });

  } catch (error) {
    console.error("Get all products error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching products",
      error: error.message
    });
  }
};


//get single product by slug
// Get single product by slug
const getProductBySlug = async (req, res) => {
  try {
    const slug = req.params.slug?.trim();

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Invalid product slug"
      });
    }

    const product = await Product.findOne({
      slug,
      status: "active"
    })
      .select(
        "name slug description price images category variants inventory soldInfo fomo createdAt"
      )
      .populate("category", "name")
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    return res.status(200).json({
      success: true,
      product
    });

  } catch (error) {
    console.error("Get product by slug error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching product",
      error: error.message
    });
  }
};

//get products with only archived status
// Get archived products (paginated)
const getArchivedProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;

    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(100, Number(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const query = { status: "archived" };

    const [products, total] = await Promise.all([
      Product.find(query)
        .select("name slug price images category archivedAt createdAt")
        .populate("category", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),

      Product.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: pageNumber,
      limit: limitNumber,
      count: products.length,
      products
    });

  } catch (error) {
    console.error("Get archived products error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching archived products",
      error: error.message
    });
  }
};


//get products with only draft status
// Get draft products (paginated)
const getDraftProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;

    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(100, Number(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const query = { status: "draft" };

    const [products, total] = await Promise.all([
      Product.find(query)
        .select("name slug price images category createdAt")
        .populate("category", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),

      Product.countDocuments(query)
    ]);

    return res.status(200).json({
      success: true,
      total,
      page: pageNumber,
      limit: limitNumber,
      count: products.length,
      products
    });

  } catch (error) {
    console.error("Get draft products error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching draft products",
      error: error.message
    });
  }
};


// Hard delete (permanently delete archived product)
const hardDeleteProduct = async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Invalid product slug"
      });
    }

    const product = await Product.findOne({ slug }).lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    if (product.status !== "archived") {
      return res.status(400).json({
        success: false,
        message: "Only archived products can be permanently deleted"
      });
    }

    const publicIds = [];

    if (Array.isArray(product.images)) {
      product.images.forEach(img => {
        if (img.publicId) publicIds.push(img.publicId);
      });
    }

    if (Array.isArray(product.variants)) {
      product.variants.forEach(variant => {
        if (Array.isArray(variant.images)) {
          variant.images.forEach(img => {
            if (img.publicId) publicIds.push(img.publicId);
          });
        }
      });
    }

    const uniquePublicIds = [...new Set(publicIds)];

    await Promise.all(
      uniquePublicIds.map(async (id) => {
        try {
          await deleteFromCloudinary(id);
        } catch (err) {
          console.error("Cloudinary delete failed:", id);
        }
      })
    );

    await Product.deleteOne({ _id: product._id });

    return res.status(200).json({
      success: true,
      message: "Product permanently deleted"
    });

  } catch (error) {
    console.error("Hard delete product error:", error);
    return res.status(500).json({
      success: false,
      message: "Error permanently deleting product",
      error: error.message
    });
  }
};
// Bulk hard delete (permanently delete multiple archived products)
// Bulk hard delete (permanently delete multiple archived products)
const bulkHardDelete = async (req, res) => {
  try {
    const { slugs } = req.body;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "slugs array is required"
      });
    }

    // ==========================================
    // 1️⃣ Fetch only archived products (lean)
    // ==========================================
    const products = await Product.find({
      slug: { $in: slugs },
      status: "archived"
    }).lean();

    if (products.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No archived products found to delete"
      });
    }

    const productIds = products.map(p => p._id);

    // ==========================================
    // 2️⃣ Collect ALL publicIds first
    // ==========================================
    const publicIds = [];

    for (const product of products) {
      if (Array.isArray(product.images)) {
        for (const img of product.images) {
          if (img.publicId) {
            publicIds.push(img.publicId);
          }
        }
      }

      if (Array.isArray(product.variants)) {
        for (const variant of product.variants) {
          if (Array.isArray(variant.images)) {
            for (const img of variant.images) {
              if (img.publicId) {
                publicIds.push(img.publicId);
              }
            }
          }
        }
      }
    }

    // ==========================================
    // 3️⃣ Delete images in parallel (SAFE)
    // ==========================================
    if (publicIds.length > 0) {
      await Promise.allSettled(
        publicIds.map(id => deleteFromCloudinary(id))
      );
    }

    // ==========================================
    // 4️⃣ Delete from DB
    // ==========================================
    const deleteResult = await Product.deleteMany({
      _id: { $in: productIds }
    });

    return res.status(200).json({
      success: true,
      message: "Products permanently deleted",
      requested: slugs.length,
      deletedCount: deleteResult.deletedCount,
      skipped: slugs.length - deleteResult.deletedCount
    });

  } catch (error) {
    console.error("Bulk hard delete error:", error);
    return res.status(500).json({
      success: false,
      message: "Error permanently deleting products",
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
