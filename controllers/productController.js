const { cloudinary , initCloudinary } = require('../config/cloudinary.config');
const Product = require('../models/Product');
const Category = require('../models/Category');
const mongoose = require('mongoose');
const slugify = require('slugify');
const { generateSlug, generateSku } = require('../utils/productUtils');
const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinaryHelper');
const sharp = require('sharp');
const fs = require('fs');
const csv = require('csv-parser');
const unzipper = require('unzipper');
const path = require('path');
const axios = require('axios');
const AdmZip = require("adm-zip");
const { Parser } = require("json2csv");   // ✅ ADD THIS



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

    if (!name || !title || !category || !description) {
      return res.status(400).json({
        success: false,
        message: "Name, title, category and description are required"
      });
    }

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
        message: "Selected category does not exist."
      });
    }

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
    const filesByVariant = {};

    // =============================
    // Group variant images
    // =============================
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const match = file.fieldname.match(/^variantImages_(\d+)$/);
        if (match) {
          const index = Number(match[1]);
          if (!filesByVariant[index]) filesByVariant[index] = [];
          filesByVariant[index].push(file);
        }
      }
    }

    for (const idxStr of Object.keys(filesByVariant)) {
      const idx = Number(idxStr);
      if (filesByVariant[idx].length > 5) {
        return res.status(400).json({
          success: false,
          message: `Variant ${idx} can have at most 5 images`
        });
      }
    }

    // =============================
    // PROCESS EACH VARIANT
    // =============================
    for (let i = 0; i < variantsInput.length; i++) {
      const v = variantsInput[i];

      // 🔒 BARCODE REQUIRED
      if (!v.barcode) {
        return res.status(400).json({
          success: false,
          message: `Barcode is required for variant ${i}`
        });
      }

      const barcodeNumber = Number(v.barcode);
      if (isNaN(barcodeNumber)) {
        return res.status(400).json({
          success: false,
          message: `Barcode must be a valid number for variant ${i}`
        });
      }

      // 🔒 CHECK DUPLICATE BARCODE IN DB
      const existingBarcode = await Product.findOne({
        "variants.barcode": barcodeNumber
      });

      if (existingBarcode) {
        return res.status(400).json({
          success: false,
          message: `Barcode ${barcodeNumber} already exists`
        });
      }

      //  AUTO GENERATE SKU
      const skuVal = await generateSku();

      // Wholesale flag
      const wholesale = !!v.wholesale;

      // Price object
      const priceObj = {
        base: Number(v.price?.base) || 0,
        sale: v.price?.sale != null ? Number(v.price.sale) : null,
        wholesaleBase: wholesale ? Number(v.price?.wholesaleBase) : undefined,
        wholesaleSale: wholesale ? (v.price?.wholesaleSale != null ? Number(v.price.wholesaleSale) : null) : undefined
      };

      if (priceObj.sale != null && priceObj.sale >= priceObj.base) {
        return res.status(400).json({
          success: false,
          message: `Sale price must be less than base price for variant ${i}`
        });
      }

      if (wholesale && priceObj.wholesaleSale != null && priceObj.wholesaleSale >= priceObj.wholesaleBase) {
        return res.status(400).json({
          success: false,
          message: `Wholesale sale price must be less than wholesale base price for variant ${i}`
        });
      }

      // MOQ logic
      let moq = 1;
      if (wholesale) {
        if (!v.minimumOrderQuantity || v.minimumOrderQuantity < 1) {
          return res.status(400).json({
            success: false,
            message: `Minimum order quantity is required and must be at least 1 for wholesale variant ${i}`
          });
        }
        moq = Number(v.minimumOrderQuantity);
      }

      const inventoryObj = {
        quantity: Number(v.inventory?.quantity) || 0,
        trackInventory: v.inventory?.trackInventory !== false,
        lowStockThreshold: v.inventory?.lowStockThreshold || 5
      };

      const variantImages = [];

      // =============================
      // Upload Variant Images
      // =============================
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
        sku: skuVal, // ✅ FROM UTILS
        barcode: barcodeNumber,
        wholesale,
        attributes: Array.isArray(v.attributes)
          ? v.attributes.map(a => ({ key: a.key, value: a.value }))
          : [],
        price: priceObj,
        minimumOrderQuantity: moq,
        inventory: inventoryObj,
        images: variantImages,
        isActive: v.isActive !== false
      });
    }

    // =============================
    // Price Range & Stock
    // =============================
    const effectivePrices = variants.map(v =>
      v.price.sale != null ? v.price.sale : v.price.base
    );

    const minPrice = Math.min(...effectivePrices);
    const maxPrice = Math.max(...effectivePrices);

    const totalStock = variants.reduce(
      (sum, v) => sum + (v.inventory.quantity || 0),
      0
    );

    // =============================
    // Parse Optional JSON Fields
    // =============================
    let parsedSoldInfo = soldInfo;
    let parsedFomo = fomo;
    let parsedShipping = shipping;
    let parsedAttributes = attributes;

    try {
      if (typeof soldInfo === "string") parsedSoldInfo = JSON.parse(soldInfo);
      if (typeof fomo === "string") parsedFomo = JSON.parse(fomo);
      if (typeof shipping === "string") parsedShipping = JSON.parse(shipping);
      if (typeof attributes === "string") parsedAttributes = JSON.parse(attributes);
    } catch {
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
      category: existingCategory._id,
      brand: brand || "Generic",
      status,
      isFeatured,
      soldInfo: parsedSoldInfo || { enabled: false, count: 0 },
      fomo: parsedFomo || { enabled: false, type: "viewing_now", viewingNow: 0 },
      shipping: parsedShipping || {
        weight: 0,
        dimensions: { length: 0, width: 0, height: 0 }
      },
      attributes: parsedAttributes || [],
      variants,
      price: {
        base: Number(req.body.price?.base) || 0,
        sale: req.body.price?.sale != null ? Number(req.body.price.sale) : null,
        wholesaleBase: Number(req.body.price?.wholesaleBase) || 0,
        wholesaleSale: req.body.price?.wholesaleSale != null ? Number(req.body.price.wholesaleSale) : null
      },
      minimumOrderQuantity: Number(req.body.minimumOrderQuantity) || 1,
      isVisibleToRetail: req.body.isVisibleToRetail || false,
      isVisibleToWholesale: req.body.isVisibleToWholesale || false
    });

    await product.save();

    return res.status(201).json({
      success: true,
      message: "Product created successfully",
      product,
      categoryDetails: existingCategory.name
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
            const wholesale = !!v.wholesale;
            const basePrice = Number(v.price?.base || 0);
            const salePrice = v.price?.sale != null ? Number(v.price.sale) : null;
            const wholesaleBase = wholesale ? Number(v.price?.wholesaleBase) : undefined;
            const wholesaleSale = wholesale ? (v.price?.wholesaleSale != null ? Number(v.price.wholesaleSale) : null) : undefined;

            if (salePrice && salePrice >= basePrice) {
              throw new Error("Invalid sale price");
            }
            if (wholesale && wholesaleSale != null && wholesaleSale >= wholesaleBase) {
              throw new Error("Invalid wholesale sale price");
            }

            let moq = 1;
            if (wholesale) {
              if (!v.minimumOrderQuantity || v.minimumOrderQuantity < 1) {
                throw new Error("Minimum order quantity required for wholesale variant");
              }
              moq = Number(v.minimumOrderQuantity);
            }

            return {
              sku: v.sku
                ? String(v.sku).toUpperCase()
                : `${slug}-VAR${index + 1}`.toUpperCase(),
              barcode: v.barcode || '',
              wholesale,
              attributes: Array.isArray(v.attributes)
                ? v.attributes.map(a => ({
                    key: a.key,
                    value: a.value
                  }))
                : [],
              price: {
                base: basePrice,
                sale: salePrice,
                wholesaleBase,
                wholesaleSale
              },
              minimumOrderQuantity: moq,
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




const importProductsFromCSV = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required",
      });
    }

    const rows = [];
    const failed = [];
    const productMap = {};

    fs.createReadStream(req.file.path)
      .pipe(
        csv({
          mapHeaders: ({ header }) => header.trim(),
        })
      )
      .on("data", (row) => rows.push(row))
      .on("end", async () => {
        try {
          for (let row of rows) {
            try {
              // ===============================
              // TRIM ALL VALUES
              // ===============================
              Object.keys(row).forEach((key) => {
                if (typeof row[key] === "string") {
                  row[key] = row[key].trim();
                }
              });

              // ===============================
              // REQUIRED FIELD VALIDATION
              // ===============================
              if (!row.name || !row.category || !row.basePrice) {
                throw new Error("Missing required fields");
              }

              const productName = row.name;

              // ===============================
              //  PRICE SANITIZATION (NEW FIX)
              // ===============================
              const cleanBasePrice = parseFloat(
                row.basePrice?.replace(/[^0-9.]/g, "")
              );

              const cleanSalePrice = row.salePrice
                ? parseFloat(row.salePrice.replace(/[^0-9.]/g, ""))
                : null;

              if (isNaN(cleanBasePrice)) {
                throw new Error("Invalid basePrice format");
              }

              // ===============================
              // CREATE PRODUCT IF NOT EXISTS
              // ===============================
              if (!productMap[productName]) {
                const slug = await generateSlug(productName);

                const categorySlug = slugify(row.category, {
                  lower: true,
                  strict: true,
                });

                let category = await Category.findOne({
                  slug: categorySlug,
                });

                if (!category) {
                  category = await Category.create({
                    name: row.category,
                    slug: categorySlug,
                    status: "active",
                    level: 0,
                  });
                }

                productMap[productName] = {
                  name: productName,
                  slug,
                  title: row.title || productName,
                  description: row.description || "",
                  category: category._id,
                  brand: row.brand || "Generic",
                  status: row.status?.toLowerCase() || "draft",
                  isFeatured: row.isfeatured === "true",
                  variants: [],
                  soldInfo: {
                    enabled: row.soldEnabled === "true",
                    count: Number(row.soldCount) || 0,
                  },
                  fomo: {
                    enabled: row.fomoEnabled === "true",
                    type: row.fomoType || "viewing_now",
                    viewingNow: Number(row.viewingNow) || 0,
                    productLeft: Number(row.productLeft) || 0,
                    customMessage: row.customMessage || "",
                  },
                };
              }

              // ===============================
              // VARIANT ATTRIBUTES
              // ===============================
              let variantAttributes = [];

              if (row.variantAttributes) {
                variantAttributes = row.variantAttributes
                  .split("|")
                  .map((pair) => {
                    const [key, value] = pair.split(":");
                    return {
                      key: key?.trim(),
                      value: value?.trim(),
                    };
                  });
              }

              // ===============================
              // PRODUCT ATTRIBUTES
              // ===============================
              let productAttributes = [];

              if (row.productAttributes) {
                productAttributes = row.productAttributes
                  .split("|")
                  .map((pair) => {
                    const [key, value] = pair.split(":");
                    return {
                      key: key?.trim(),
                      value: value?.trim(),
                    };
                  });
              }

              // ===============================
              // IMAGE UPLOAD FROM URL (UNCHANGED)
              // ===============================
              let imagesArr = [];

              if (row.images) {
                const imageUrls = row.images
                  .split(",")
                  .map((u) => u.trim())
                  .slice(0, 5);

                for (let url of imageUrls) {
                  if (!url) continue;

                  try {
                    if (url.startsWith("data:image")) {
                      const uploadResult =
                        await cloudinary.uploader.upload(url, {
                          resource_type: "image",
                        });

                      imagesArr.push({
                        url: uploadResult.secure_url,
                        publicId: uploadResult.public_id,
                        altText: productName,
                        order: imagesArr.length,
                      });
                    } else if (url.startsWith("http")) {
                      const response = await axios({
                        method: "GET",
                        url: url,
                        responseType: "arraybuffer",
                        timeout: 15000,
                        headers: {
                          "User-Agent": "Mozilla/5.0",
                        },
                      });

                      const base64 = Buffer.from(response.data).toString(
                        "base64"
                      );
                      const mimeType = response.headers["content-type"];
                      const dataURI = `data:${mimeType};base64,${base64}`;

                      const uploadResult =
                        await cloudinary.uploader.upload(dataURI, {
                          resource_type: "image",
                        });

                      imagesArr.push({
                        url: uploadResult.secure_url,
                        publicId: uploadResult.public_id,
                        altText: productName,
                        order: imagesArr.length,
                      });
                    }
                  } catch (err) {
                    console.log("Image upload failed:", url);
                    console.log("ERROR:", err.message);
                  }
                }
              }

              // ===============================
               // BUILD VARIANT OBJECT
               // ===============================
               const wholesale = row.wholesale === "true";
               const wholesaleBase = wholesale ? Number(row.wholesaleBase) : undefined;
               const wholesaleSale = wholesale ? (row.wholesaleSale ? Number(row.wholesaleSale) : null) : undefined;
               let moq = 1;
               if (wholesale) {
                 moq = row.minimumOrderQuantity && Number(row.minimumOrderQuantity) > 0 ? Number(row.minimumOrderQuantity) : 1;
               }
               const variant = {
                 sku:
                   "SKU-" +
                   Math.floor(100000 + Math.random() * 900000),
                 barcode: row.barcode || "",
                 wholesale,
                 attributes: variantAttributes,
                 weight: Number(row.weight) || 0,
                 dimensions: {
                   length: Number(row.length) || 0,
                   width: Number(row.width) || 0,
                   height: Number(row.height) || 0,
                 },
                 price: {
                   base: cleanBasePrice,
                   sale: cleanSalePrice
                     ? Number(cleanSalePrice)
                     : null,
                   wholesaleBase,
                   wholesaleSale
                 },
                 minimumOrderQuantity: moq,
                 inventory: {
                   quantity: Number(row.quantity) || 0,
                   trackInventory: true,
                   lowStockThreshold: 5,
                 },
                 images: imagesArr,
                 isActive: true,
               };

               productMap[productName].variants.push(variant);

              if (
                productAttributes.length &&
                !productMap[productName].productAttributes
              ) {
                productMap[productName].productAttributes =
                  productAttributes;
              }
            } catch (err) {
              failed.push({
                product: row.name || "Unknown",
                error: err.message,
              });
            }
          }

          const finalProducts = Object.values(productMap);
          let inserted = [];

          if (finalProducts.length > 0) {
            inserted = await Product.insertMany(finalProducts);
          }

          fs.unlinkSync(req.file.path);

          return res.status(200).json({
            success: true,
            totalRows: rows.length,
            insertedProducts: inserted.length,
            failedCount: failed.length,
            failed,
          });
        } catch (err) {
          return res.status(500).json({
            success: false,
            message: "Processing failed",
            error: err.message,
          });
        }
      });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "CSV import failed",
      error: error.message,
    });
  }
};


// Bulk upload products with images via CSV and ZIP
const bulkUploadNewProductsWithImages = async (req, res) => {
  try {

    if (!req.files?.csvFile || !req.files?.imagesZip) {
      return res.status(400).json({
        success: false,
        message: "CSV file and images ZIP are required"
      });
    }

    const csvPath = req.files.csvFile[0].path;
    const zipPath = req.files.imagesZip[0].path;

    const extractPath = path.join(__dirname, "../uploads/extracted");

    // =============================
    // CLEAN OLD EXTRACTED FOLDER
    // =============================

    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }

    fs.mkdirSync(extractPath, { recursive: true });

    // =============================
    // Extract ZIP
    // =============================

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    const extractedFolders = fs.readdirSync(extractPath);

    const rootFolder =
      extractedFolders.length === 1
        ? path.join(extractPath, extractedFolders[0])
        : extractPath;

    // =============================
    // Parse CSV
    // =============================

    const rows = [];

    await new Promise((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(csv())
        .on("data", (data) => rows.push(data))
        .on("end", resolve)
        .on("error", reject);
    });

    // =============================
    // Attribute Parsers
    // =============================

    const parseAttributes = (attrString) => {

      if (!attrString) return [];

      return attrString.split("|").map(item => {

        const [key, value] = item.split(":");

        return {
          key: key?.trim(),
          value: value?.trim()
        };

      }).filter(attr => attr.key && attr.value);

    };

    const success = [];
    const failed = [];

    for (const row of rows) {

      try {

        const barcode = Number(row.barcode);

        if (isNaN(barcode)) {
          throw new Error("Invalid barcode");
        }

        // =============================
        // CATEGORY LOOKUP
        // =============================

        const categoryDoc = await Category.findOne({
          name: row.category
        });

        if (!categoryDoc) {
          throw new Error(`Category not found: ${row.category}`);
        }

        let product = await Product.findOne({ name: row.name });

        // =============================
        // IMAGE FOLDER
        // =============================

        const imageFolder = path.join(rootFolder, String(barcode));

        if (!fs.existsSync(imageFolder)) {
          throw new Error(`Image folder not found for barcode ${barcode}`);
        }

        const files = fs.readdirSync(imageFolder);

        if (!files.length) {
          throw new Error(`No images found for barcode ${barcode}`);
        }

        // =============================
        // PARALLEL CLOUDINARY UPLOAD
        // =============================

        const uploadPromises = files.map(async (file, index) => {

          const filePath = path.join(imageFolder, file);

          const buffer = fs.readFileSync(filePath);

          const upload = await uploadToCloudinary(
            buffer,
            "products",
            `${row.name}-${barcode}-${index}`
          );

          return {
            url: upload.url,
            publicId: upload.publicId,
            altText: row.name,
            order: index
          };

        });

        const variantImages = await Promise.all(uploadPromises);

        // =============================
        // PRICE VALIDATION
        // =============================

        const basePrice = Number(row.basePrice);

        if (isNaN(basePrice)) {
          throw new Error(`Invalid base price for barcode ${barcode}`);
        }

        const salePrice = row.salePrice ? Number(row.salePrice) : null;

        // =============================
        // ATTRIBUTES
        // =============================

        const variantAttributes = parseAttributes(row.variantAttributes);
        const productAttributes = parseAttributes(row.productAttributes);

        // =============================
        // VARIANT
        // =============================

        const sku = await generateSku();

        const newVariant = {
          sku,
          barcode,
          attributes: variantAttributes,
          price: {
            base: basePrice,
            sale: salePrice
              ? Number(cleanSalePrice)
              : null,
          },
          inventory: {
            quantity: Number(row.quantity || 0)
          },
          images: variantImages
        };

        // =============================
        // PRODUCT CREATE / UPDATE
        // =============================

        if (product) {

          product.variants.push(newVariant);

          await product.save();

        } else {

          const slug = await generateSlug(row.name);

          product = new Product({
            name: row.name,
            title: row.title || row.name,
            slug,
            description: row.description || "",
            category: categoryDoc._id,
            brand: row.brand || null,
            status: row.status || "draft",
            isFeatured: row.isfeatured === "true",
            attributes: productAttributes,
            variants: [newVariant]
          });

          await product.save();
        }

        success.push({
          name: row.name,
          barcode
        });

      } catch (err) {

        failed.push({
          name: row.name || "Unknown",
          barcode: row.barcode || null,
          error: err.message
        });

      }
    }

    // =============================
    // ERROR CSV GENERATION
    // =============================

    let errorCsvPath = null;

    if (failed.length > 0) {

      const parser = new Parser({
        fields: ["name", "barcode", "error"]
      });

      const csvData = parser.parse(failed);

      const fileName = `failed-products-${Date.now()}.csv`;

      errorCsvPath = path.join(__dirname, "../uploads", fileName);

      fs.writeFileSync(errorCsvPath, csvData);
    }

    return res.status(200).json({
      success: true,
      message: "Bulk upload completed",
      totalRows: rows.length,
      successfulUploads: success.length,
      failedUploads: failed.length,
      errorReport: errorCsvPath
        ? `/uploads/${path.basename(errorCsvPath)}`
        : null,
      errors: failed
    });

  } catch (error) {

    console.error("Bulk upload error:", error);

    return res.status(500).json({
      success: false,
      message: "Bulk upload failed",
      error: error.message
    });
  }
};

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
    delete updates.variants;

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

    // =====================================================
    // ✅ VARIANT UPDATE BY BARCODE
    // =====================================================

    if (updates.barcode) {

      const barcodeNumber = Number(updates.barcode);

      if (isNaN(barcodeNumber)) {
        return res.status(400).json({
          success: false,
          message: "Invalid barcode"
        });
      }

      const variantIndex = existingProduct.variants.findIndex(
        v => v.barcode === barcodeNumber
      );

      if (variantIndex === -1) {
        return res.status(404).json({
          success: false,
          message: "No product found with this barcode"
        });
      }

      const existingVariant = existingProduct.variants[variantIndex];

      const updateFields = {};

      // =========================
      // PRICE UPDATE
      // =========================

      if (updates.price) {

        const parsedPrice = parseIfString(updates.price, {});

        const base =
          parsedPrice.base !== undefined
            ? Number(parsedPrice.base)
            : existingVariant.price.base;

        const sale =
          parsedPrice.sale !== undefined
            ? parsedPrice.sale != null
              ? Number(parsedPrice.sale)
              : null
            : existingVariant.price.sale;

        if (sale != null && sale >= base) {
          return res.status(400).json({
            success: false,
            message: "Sale price must be less than base price"
          });
        }

        if (parsedPrice.base !== undefined) {
          updateFields["variants.$.price.base"] = base;
        }

        if (parsedPrice.sale !== undefined) {
          updateFields["variants.$.price.sale"] = sale;
        }
      }

      // =========================
      // INVENTORY UPDATE
      // =========================

      if (updates.inventory) {

        const parsedInventory = parseIfString(updates.inventory, {});

        if (parsedInventory.quantity !== undefined) {
          updateFields["variants.$.inventory.quantity"] =
            Number(parsedInventory.quantity);
        }

        if (parsedInventory.lowStockThreshold !== undefined) {
          updateFields["variants.$.inventory.lowStockThreshold"] =
            Number(parsedInventory.lowStockThreshold);
        }

        if (parsedInventory.trackInventory !== undefined) {
          updateFields["variants.$.inventory.trackInventory"] =
            parsedInventory.trackInventory;
        }
      }

      // =========================
      // ✅ IMAGES UPDATE (FIXED)
      // =========================

      if (req.files && req.files.length > 0) {

        // delete old images
        if (existingVariant.images && existingVariant.images.length > 0) {

          for (const img of existingVariant.images) {

            if (img.publicId) {
              await deleteFromCloudinary(img.publicId);
            }

          }

        }

        const uploadedImages = [];

        for (let i = 0; i < req.files.length; i++) {

          const file = req.files[i];

          // ensure buffer exists
          if (!file.buffer) {
            continue;
          }

          const uploadResult = await uploadToCloudinary(
            file.buffer,
            "products"
          );

          uploadedImages.push({
            url: uploadResult.url,
            publicId: uploadResult.publicId,
            altText: existingProduct.name,
            order: i
          });

        }

        updateFields["variants.$.images"] = uploadedImages;

      }

      const updatedProduct = await Product.findOneAndUpdate(
        { slug, "variants.barcode": barcodeNumber },
        { $set: updateFields },
        { new: true }
      );

      // 🔁 Recalculate totals
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

      await updatedProduct.save();

      return res.status(200).json({
        success: true,
        message: "Variant updated successfully",
        product: updatedProduct
      });

    }

    // =====================================================
    // PRODUCT FIELD UPDATE
    // =====================================================

    if (updates.name && updates.name !== existingProduct.name) {

      updates.slug = await generateSlug(
        updates.name,
        existingProduct._id
      );

    }

    if (updates.soldInfo) {

      const parsed = parseIfString(updates.soldInfo, {});

      updates.soldInfo = {
        ...existingProduct.soldInfo.toObject(),
        ...parsed,
        enabled: parsed.enabled === true || parsed.enabled === "true",
        count: Number(parsed.count ?? 0)
      };

    }

    if (updates.fomo) {

      const parsed = parseIfString(updates.fomo, {});

      updates.fomo = {
        ...existingProduct.fomo.toObject(),
        ...parsed,
        enabled: parsed.enabled === true || parsed.enabled === "true",
        viewingNow: Number(parsed.viewingNow ?? 0),
        productLeft: Number(parsed.productLeft ?? 0),
        type: ["viewing_now", "product_left", "custom"].includes(parsed.type)
          ? parsed.type
          : existingProduct.fomo.type
      };

    }

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

    if (updates.attributes) {

      const parsed = parseIfString(updates.attributes, []);

      updates.attributes = Array.isArray(parsed)
        ? parsed.map(a => ({ key: a.key, value: a.value }))
        : [];

    }

    const updatedProduct = await Product.findByIdAndUpdate(
      existingProduct._id,
      { $set: updates },
      { new: true, runValidators: true }
    );

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
const getAllActiveProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;

    const pageNumber = Math.max(1, Number(page));
    const limitNumber = Math.min(100, Number(limit));
    const skip = (pageNumber - 1) * limitNumber;

    const query = { status: "active" };

    const [products, total] = await Promise.all([
      Product.find(query)
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

//get All prodcuts or admin with limits and q 

const getAllProductsAdmin = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;

    page = Number(page);
    // limit = Number(limit);
    limit = Math.min(100, Math.max(1, Number(limit))); // max 10

    const skip = (page - 1) * limit;

    let query = {};

   

    const products = await Product.find()
      .sort({ createdAt: -1 }) // latest first
      .skip(skip)
      .limit(limit);

    const totalProducts = await Product.countDocuments();

    return res.status(200).json({
      success: true,
       totalProducts,
      totalPages: Math.ceil(totalProducts / limit),
      currentPage: page,
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



//Add variant to existing product
// Add variant to existing product
const addVariant = async (req, res) => {
  try {

    const { slug } = req.params;

    const product = await Product.findOne({ slug });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    // =========================
    // Parse body safely
    // =========================
    let variant = req.body;

    if (typeof variant === "string") {
      variant = JSON.parse(variant);
    }

    // =========================
    // 🔒 BARCODE VALIDATION
    // =========================
    if (!variant.barcode) {
      return res.status(400).json({
        success: false,
        message: "Barcode is required"
      });
    }

    const barcodeNumber = Number(variant.barcode);

    if (isNaN(barcodeNumber)) {
      return res.status(400).json({
        success: false,
        message: "Barcode must be a valid number"
      });
    }

    // 🔒 Global duplicate check
    const barcodeExists = await Product.exists({
      "variants.barcode": barcodeNumber
    });

    if (barcodeExists) {
      return res.status(400).json({
        success: false,
        message: "Variant with this barcode already exists"
      });
    }

    // =========================
    // 🔒 PRICE VALIDATION
    // =========================
    if (!variant.price?.base) {
      return res.status(400).json({
        success: false,
        message: "Base price is required"
      });
    }

    const basePrice = Number(variant.price.base);

    const salePrice =
      variant.price.sale != null
        ? Number(variant.price.sale)
        : null;

    if (salePrice != null && salePrice >= basePrice) {
      return res.status(400).json({
        success: false,
        message: "Sale price must be less than base price"
      });
    }

    // =========================
    // 🔥 AUTO GENERATE SKU
    // =========================
    const skuVal = await generateSku();

    // =========================
    // 📸 IMAGE UPLOAD
    // =========================
    let uploadedImages = [];

    if (req.files && req.files.length > 0) {

      for (let i = 0; i < req.files.length; i++) {

        const file = req.files[i];

        if (!file.buffer) continue;

        const uploadResult = await uploadToCloudinary(
          file.buffer,
          "products"
        );

        uploadedImages.push({
          url: uploadResult.url,
          publicId: uploadResult.publicId,
          altText: product.name,
          order: i
        });

      }

    }

    // =========================
    // BUILD NEW VARIANT
    // =========================
    const newVariant = {
      sku: skuVal,
      barcode: barcodeNumber,

      attributes: Array.isArray(variant.attributes)
        ? variant.attributes.map(a => ({
            key: a.key,
            value: a.value
          }))
        : [],

      price: {
        base: basePrice,
        sale: salePrice
      },

      inventory: {
        quantity: Number(variant.inventory?.quantity || 0),
        lowStockThreshold: Number(
          variant.inventory?.lowStockThreshold || 5
        ),
        trackInventory:
          variant.inventory?.trackInventory ?? true
      },

      images: uploadedImages,

      isActive: variant.isActive !== false
    };

    product.variants.push(newVariant);

    // =========================
    // 🔁 RECALCULATE TOTALS
    // =========================
    const effectivePrices = product.variants.map(v =>
      v.price.sale != null ? v.price.sale : v.price.base
    );

    product.priceRange = {
      min: Math.min(...effectivePrices),
      max: Math.max(...effectivePrices)
    };

    product.totalStock = product.variants.reduce(
      (sum, v) => sum + (v.inventory.quantity || 0),
      0
    );

    await product.save();

    return res.status(200).json({
      success: true,
      message: "Variant added successfully",
      product
    });

  } catch (error) {

    console.error("Add variant error:", error);

    return res.status(500).json({
      success: false,
      message: "Error adding variant",
      error: error.message
    });

  }
};

//delete variant from existing product
//Add variant to existing product
// Add variant to existing product
// Delete variant from existing product
const deleteVariant = async (req, res) => {
  try {
    const { slug } = req.params;
    const { barcode } = req.body;

    if (!barcode) {
      return res.status(400).json({
        success: false,
        message: "Barcode is required"
      });
    }

    const barcodeNumber = Number(barcode);

    if (isNaN(barcodeNumber)) {
      return res.status(400).json({
        success: false,
        message: "Invalid barcode"
      });
    }

    const product = await Product.findOne({ slug });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    // 🔒 Check variant exists
    const variantExists = product.variants.some(
      v => v.barcode === barcodeNumber
    );

    if (!variantExists) {
      return res.status(404).json({
        success: false,
        message: "Variant not found"
      });
    }

    // 🔒 Prevent deleting last variant (recommended)
    if (product.variants.length === 1) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete last variant of product"
      });
    }

    // 🔥 REMOVE VARIANT
    product.variants = product.variants.filter(
      v => v.barcode !== barcodeNumber
    );

    // 🔁 RECALCULATE PRICE RANGE
    const effectivePrices = product.variants.map(v =>
      v.price.sale != null ? v.price.sale : v.price.base
    );

    product.priceRange = {
      min: Math.min(...effectivePrices),
      max: Math.max(...effectivePrices)
    };
        
    // 🔁 RECALCULATE STOCK
    product.totalStock = product.variants.reduce(
      (sum, v) => sum + (v.inventory.quantity || 0),
      0
    );
         
    await product.save();

    return res.status(200).json({
      success: true,
      message: "Variant deleted successfully",
      product
    });

  } catch (error) {
    console.error("Delete variant error:", error);
    return res.status(500).json({
      success: false,
      message: "Error deleting variant",
      error: error.message
    });
  }
};

//get variant by barcode
// Get product + specific variant by barcode
const getVariantByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;

    if (!barcode) {
      return res.status(400).json({
        success: false,
        message: "Barcode is required"
      });
    }

    const barcodeNumber = Number(barcode);

    if (isNaN(barcodeNumber)) {
      return res.status(400).json({
        success: false,
        message: "Invalid barcode"
      });
    }

    // 🔍 Optimized query (returns only matched variant)
    const product = await Product.findOne(
      { "variants.barcode": barcodeNumber },
      {
        name: 1,
        slug: 1,
        brand: 1,
        category: 1,
        fomo: 1,
        soldInfo: 1,
        "variants.$": 1
      }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "No product found for this barcode"
      });
    }

    return res.status(200).json({
      success: true,
      product: {
        _id: product._id,
        name: product.name,
        slug: product.slug,
        brand: product.brand,
        category: product.category,
        fomo: product.fomo,
        soldInfo: product.soldInfo
      },
      variant: product.variants[0] // matched variant
    });

  } catch (error) {
    console.error("Get variant by barcode error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching variant",
      error: error.message
    });
  }
};

// Get product details with user-specific pricing
const getProductDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await Product.findById(id).populate('category');
    if (!product) return res.status(404).json({ message: 'Product not found' });

    let price;
    if (req.userType === 'wholesaler') {
      price = {
        base: product.price.wholesaleBase,
        sale: product.price.wholesaleSale || product.price.wholesaleBase,
        minimumOrderQuantity: product.minimumOrderQuantity
      };
    } else {
      price = {
        base: product.price.base,
        sale: product.price.sale || product.price.base
      };
    }

    res.status(200).json({
      product,
      price
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching product details', error });
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
  getAllActiveProducts,
  getProductBySlug , 
   bulkCreateProducts ,
   bulkRestore  , 
   importProductsFromCSV ,
   getAllProductsAdmin , 
   addVariant,
   deleteVariant,
   getVariantByBarcode,
   bulkUploadNewProductsWithImages,
   getProductDetails
};
