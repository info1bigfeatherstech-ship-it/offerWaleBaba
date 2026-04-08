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
const {generateSEOData}=require("../utils/seoUtils");



// =============================================
// HELPER: Parse boolean from various formats
// =============================================
function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  return false;
}


// Create new product
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
      variants: variantsRaw,
      // ✅ NEW FIELDS
      hsnCode,
      taxRate,
      isFragile
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

      // AUTO GENERATE SKU
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
        sku: skuVal,
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

    // =============================
    // ✅ VALIDATE HSN CODE (Optional)
    // =============================
    let finalHsnCode = null;
    if (hsnCode && hsnCode.trim()) {
      finalHsnCode = hsnCode.trim().toUpperCase();
      if (finalHsnCode.length > 20) {
        return res.status(400).json({
          success: false,
          message: "HSN code cannot exceed 20 characters"
        });
      }
    }

    // =============================
    // ✅ VALIDATE TAX RATE (Optional - no default)
    // =============================
    let finalTaxRate = null;
    if (taxRate !== undefined && taxRate !== null) {
      const parsedTaxRate = Number(taxRate);
      if (isNaN(parsedTaxRate) || parsedTaxRate < 0) {
        return res.status(400).json({
          success: false,
          message: "Tax rate must be a valid number greater than or equal to 0"
        });
      }
      finalTaxRate = parsedTaxRate;
    }
    // ⚠️ No default value - if not provided, stays null

    // =============================
    // ✅ FRAGILE FLAG (Boolean)
    // =============================
    const finalIsFragile = isFragile === true || isFragile === "true";

    // =============================
    // ✅ CREATE PRODUCT
    // =============================
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
      isVisibleToWholesale: req.body.isVisibleToWholesale || false,
      
      // ✅ NEW FIELDS (NO DEFAULTS)
      hsnCode: finalHsnCode,
      taxRate: finalTaxRate,
      isFragile: finalIsFragile
    });

    // =============================
    // ✅ AUTO-GENERATE SEO DATA
    // =============================
    const categoryForSEO = existingCategory ? { name: existingCategory.name } : null;

    const seoData = generateSEOData({
        name: product.name,
        description: product.description,
        category: categoryForSEO,
        variants: product.variants
    });

    product.seo = seoData;

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


//Bulk upload from CSV (with image URLs)
const importProductsFromCSV = async (req, res) => {
  let filePath = null;
  const BATCH_SIZE = 50;
  
  // Track overall stats
  const stats = {
    totalRows: 0,
    uniqueProducts: 0,
    inserted: 0,
    updated: 0,
    failed: [],
    skipped: []
  };
  
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required",
      });
    }

    const absolutePath = path.resolve(req.file.path);
    filePath = absolutePath;
    
    console.log(`📁 CSV file at: ${absolutePath}`);

    if (!fs.existsSync(absolutePath)) {
      return res.status(400).json({
        success: false,
        message: "Uploaded file not found",
      });
    }

    // =============================================
    // STEP 1: Read and validate CSV
    // =============================================
    const rows = [];
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath)
        .pipe(csv({ mapHeaders: ({ header }) => header.trim() }));
      
      stream.on("data", (row) => rows.push(row));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    
    stats.totalRows = rows.length;
    console.log(`📊 Total rows in CSV: ${stats.totalRows}`);
    
    // =============================================
    // STEP 2: Validate CSV structure
    // =============================================
    const requiredColumns = ['name', 'category', 'basePrice'];
    const firstRow = rows[0];
    const missingColumns = requiredColumns.filter(col => !firstRow.hasOwnProperty(col));
    
    if (missingColumns.length > 0) {
      // Cleanup file
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({
        success: false,
        message: `Missing required columns: ${missingColumns.join(', ')}`,
        requiredColumns
      });
    }
    
    // =============================================
    // STEP 3: Group rows by product name
    // =============================================
    const productMap = new Map();
    
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      
      // Trim all values
      Object.keys(row).forEach((key) => {
        if (typeof row[key] === "string") {
          row[key] = row[key].trim();
        }
      });
      
      const productName = row.name;
      if (!productName) {
        stats.failed.push({
          product: "Unknown",
          reason: "Product name is missing",
          rowNumber: idx + 2
        });
        continue;
      }
      
      const key = productName.toLowerCase();
      
      if (!productMap.has(key)) {
        productMap.set(key, {
          name: productName,
          rows: [],
          originalIndex: idx
        });
      }
      productMap.get(key).rows.push({ ...row, rowNumber: idx + 2 });
    }
    
    stats.uniqueProducts = productMap.size;
    console.log(`📦 Unique products: ${stats.uniqueProducts}`);
    
    // =============================================
    // STEP 4: Process products (SYNCHRONOUSLY)
    // =============================================
    let batchNumber = 0;
    let currentBatch = [];
    
    const productsArray = Array.from(productMap.values());
    
    for (let i = 0; i < productsArray.length; i++) {
      const { name: productName, rows: productRows } = productsArray[i];
      
      try {
        // Process single product with all its variants
        const result = await processProductWithRollback(productName, productRows, stats);
        
        if (result.success) {
          if (result.action === 'inserted') {
            stats.inserted++;
          } else if (result.action === 'updated') {
            stats.updated++;
          }
          currentBatch.push(result.product);
        } else {
          stats.failed.push({
            product: productName,
            reason: result.error,
            rows: productRows.map(r => r.rowNumber)
          });
        }
        
        // Insert batch when full
        if (currentBatch.length >= BATCH_SIZE) {
          batchNumber++;
          await flushBatch(currentBatch, batchNumber, stats);
          currentBatch = [];
        }
        
        const progress = ((i + 1) / productsArray.length * 100).toFixed(2);
        console.log(`📈 Progress: ${progress}% | Inserted: ${stats.inserted} | Updated: ${stats.updated} | Failed: ${stats.failed.length}`);
        
      } catch (productError) {
        console.error(`❌ Error processing ${productName}:`, productError.message);
        stats.failed.push({
          product: productName,
          reason: productError.message,
          rows: productRows.map(r => r.rowNumber)
        });
      }
    }
    
    // Final batch
    if (currentBatch.length > 0) {
      batchNumber++;
      await flushBatch(currentBatch, batchNumber, stats);
    }
    
    // =============================================
    // STEP 5: Generate failure report
    // =============================================
    let errorReportUrl = null;
    
    if (stats.failed.length > 0) {
      const report = await generateErrorReport(stats.failed, req);
      errorReportUrl = report.downloadUrl;
      console.log(`📄 Error report ready: ${errorReportUrl}`);
    }
    
    // Cleanup
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // =============================================
    // STEP 6: Send FINAL response with download link
    // =============================================
    console.log(`\n🎉 IMPORT COMPLETED!`);
    console.log(`📊 Summary:`);
    console.log(`   ✅ Inserted: ${stats.inserted}`);
    console.log(`   🔄 Updated: ${stats.updated}`);
    console.log(`   ❌ Failed: ${stats.failed.length}`);
    
    return res.status(200).json({
      success: true,
      message: "Import completed",
      totalRows: stats.totalRows,
      uniqueProducts: stats.uniqueProducts,
      inserted: stats.inserted,
      updated: stats.updated,
      failed: stats.failed.length,
      downloadUrl: errorReportUrl  // ✅ Direct download link in response
    });
    
  } catch (error) {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch(e) {}
    }
    console.error("CSV import error:", error);
    return res.status(500).json({
      success: false,
      message: "CSV import failed",
      error: error.message,
    });
  }
};
// =============================================
// HELPER: Process single product with rollback
// =============================================
async function processProductWithRollback(productName, productRows, stats) {
  const firstRow = productRows[0];
  
  try {
    let existingProduct = await Product.findOne({ 
      name: { $regex: new RegExp(`^${productName}$`, 'i') }
    });
    
    const variants = [];
    const duplicateBarcodes = new Map();
    
    // FIRST: Validate all barcodes before building anything
    for (const row of productRows) {
      const barcode = row.barcode?.trim();
      if (!barcode) continue;
      
      // Check duplicate in same CSV
      if (duplicateBarcodes.has(barcode)) {
        throw new Error(`Duplicate barcode ${barcode} found in same product. Row ${row.rowNumber} and ${duplicateBarcodes.get(barcode)}`);
      }
      duplicateBarcodes.set(barcode, row.rowNumber);
      
      // Check if barcode already exists in database (across ALL products)
      const existingProductWithBarcode = await Product.findOne({
        'variants.barcode': Number(barcode)
      });
      
      if (existingProductWithBarcode) {
        // If we're updating the SAME product, check if this barcode is already in it
        if (existingProduct && existingProduct._id.toString() === existingProductWithBarcode._id.toString()) {
          // Same product - check if variant with this barcode already exists
          const barcodeExistsInProduct = existingProduct.variants.some(v => v.barcode === Number(barcode));
          if (barcodeExistsInProduct) {
            throw new Error(`Barcode ${barcode} already exists as a variant in product "${productName}". Please use unique barcode.`);
          }
        } else {
          // Different product - block immediately
          throw new Error(`Barcode ${barcode} already exists in product "${existingProductWithBarcode.name}". Please use unique barcode.`);
        }
      }
    }
    
    // SECOND: Build all variants (validation passed)
    for (const row of productRows) {
      const variant = await buildVariantWithValidation(row, productName);
      variants.push(variant);
    }
    
    // THIRD: Save to database
    if (existingProduct) {
      let addedCount = 0;
      
      for (const variant of variants) {
        // Final safety check - verify barcode not already in product
        const barcodeExists = existingProduct.variants.some(v => v.barcode === variant.barcode);
        if (barcodeExists) {
          stats.skipped.push({
            product: productName,
            barcode: variant.barcode,
            reason: "Variant with same barcode already exists in this product"
          });
          continue;
        }
        
        // Check for duplicate attributes
        const attributeMatch = existingProduct.variants.some(v => 
          JSON.stringify(v.attributes) === JSON.stringify(variant.attributes)
        );
        
        if (attributeMatch) {
          stats.skipped.push({
            product: productName,
            barcode: variant.barcode,
            attributes: variant.attributes,
            reason: "Variant with same attributes already exists"
          });
          continue;
        }
        
        existingProduct.variants.push(variant);
        addedCount++;
      }
      
      if (addedCount === 0) {
        return { success: true, action: 'skipped', product: existingProduct };
      }
      
      // Update SEO
      const category = await Category.findById(existingProduct.category);
      const seoData = generateSEOData({
        name: existingProduct.name,
        slug: existingProduct.slug,
        description: existingProduct.description,
        category: category ? { name: category.name } : null,
        variants: existingProduct.variants,
      });
      existingProduct.seo = seoData;
      
      await existingProduct.save();
      return { success: true, action: 'updated', product: existingProduct };
      
    } else {
      // New product - create directly
      const newProduct = await buildNewProductWithVariants(productName, productRows, variants);
      return { success: true, action: 'inserted', product: newProduct };
    }
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// =============================================
// HELPER: Build variant with wholesale validation
// =============================================
async function buildVariantWithValidation(row, productName) {
  const cleanBasePrice = parseFloat(row.basePrice?.replace(/[^0-9.]/g, "") || 0);
  const cleanSalePrice = row.salePrice ? parseFloat(row.salePrice.replace(/[^0-9.]/g, "")) : null;
  
  if (isNaN(cleanBasePrice)) {
    throw new Error(`Invalid basePrice: ${row.basePrice} (Row ${row.rowNumber})`);
  }
  
  // ✅ WHOLESALE HANDLING WITH VALIDATION
 const wholesale = parseBoolean(row.wholesale);
  
  let wholesaleBase = null;
  let wholesaleSale = null;
  let moq = 1;
  
  if (wholesale) {
    // Validate wholesaleBase is provided
    if (!row.wholesaleBase || row.wholesaleBase.trim() === "") {
      throw new Error(`wholesaleBase is required when wholesale=true (Row ${row.rowNumber})`);
    }
    
    wholesaleBase = Number(row.wholesaleBase?.replace(/[^0-9.]/g, ""));
    if (isNaN(wholesaleBase)) {
      throw new Error(`Invalid wholesaleBase: ${row.wholesaleBase} (Row ${row.rowNumber})`);
    }
    
    if (row.wholesaleSale && row.wholesaleSale.trim() !== "") {
      wholesaleSale = Number(row.wholesaleSale?.replace(/[^0-9.]/g, ""));
      if (isNaN(wholesaleSale)) {
        throw new Error(`Invalid wholesaleSale: ${row.wholesaleSale} (Row ${row.rowNumber})`);
      }
      
      // Validate wholesaleSale < wholesaleBase
      if (wholesaleSale >= wholesaleBase) {
        throw new Error(`wholesaleSale (${wholesaleSale}) must be less than wholesaleBase (${wholesaleBase}) (Row ${row.rowNumber})`);
      }
    }
    
    // MOQ handling
    moq = row.minimumOrderQuantity && Number(row.minimumOrderQuantity) > 0 
      ? Number(row.minimumOrderQuantity) 
      : 1;
      
    if (moq < 1) {
      throw new Error(`minimumOrderQuantity must be at least 1 (Row ${row.rowNumber})`);
    }
  }
  
  // ✅ Validate sale price < base price
  if (cleanSalePrice && cleanSalePrice >= cleanBasePrice) {
    throw new Error(`Sale price (${cleanSalePrice}) must be less than base price (${cleanBasePrice}) (Row ${row.rowNumber})`);
  }
  
  // Attributes
  const variantAttributes = row.variantAttributes
    ? row.variantAttributes.split("|").map((pair) => {
        const [key, value] = pair.split(":");
        return { key: key?.trim(), value: value?.trim() };
      }).filter(attr => attr.key && attr.value)
    : [];
  
  // Images with retry
  let imagesArr = [];
  if (row.images) {
    const imageUrls = row.images.split(",").map((u) => u.trim()).slice(0, 5);
    
    for (let url of imageUrls) {
      if (!url) continue;
      
      let uploadSuccess = false;
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          let uploadResult;
          
          if (url.startsWith("data:image")) {
            const base64Data = url.split(',')[1];
            const imageBuffer = Buffer.from(base64Data, 'base64');
            
            const optimizedBuffer = await sharp(imageBuffer)
              .resize({ width: 1500, withoutEnlargement: true })
              .webp({ quality: 85 })
              .toBuffer();
            
            uploadResult = await new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                { folder: "products", resource_type: "image" },
                (error, result) => {
                  if (error) reject(error);
                  else resolve(result);
                }
              );
              uploadStream.end(optimizedBuffer);
            });
            
          } else if (url.startsWith("http")) {
            const response = await axios({
              method: "GET",
              url: url,
              responseType: "arraybuffer",
              timeout: 15000,
              headers: { "User-Agent": "Mozilla/5.0" },
            });
            
            const optimizedBuffer = await sharp(response.data)
              .resize({ width: 1500, withoutEnlargement: true })
              .webp({ quality: 85 })
              .toBuffer();
            
            uploadResult = await new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                { folder: "products", resource_type: "image" },
                (error, result) => {
                  if (error) reject(error);
                  else resolve(result);
                }
              );
              uploadStream.end(optimizedBuffer);
            });
          } else {
            continue;
          }
          
          imagesArr.push({
            url: uploadResult.secure_url,
            publicId: uploadResult.public_id,
            altText: productName,
            order: imagesArr.length,
          });
          
          uploadSuccess = true;
          break;
          
        } catch (err) {
          console.log(`⚠️ Image upload attempt ${attempt} failed for ${url}:`, err.message);
          if (attempt === 3) {
            console.log(`❌ Image upload failed after 3 attempts: ${url}`);
          } else {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
      
      if (!uploadSuccess) {
        console.log(`⚠️ Using original URL as fallback: ${url}`);
        imagesArr.push({
          url: url,
          publicId: null,
          altText: productName,
          order: imagesArr.length,
        });
      }
    }
  }
  
  // Generate unique SKU and Barcode
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000);
  
  return {
    sku: row.sku || (row.barcode ? `SKU-${row.barcode}` : `SKU-${timestamp}-${random}`),
    barcode: row.barcode ? Number(row.barcode) : Number(`${timestamp}${random}`.slice(0, 15)),
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
      sale: cleanSalePrice ? Number(cleanSalePrice) : null,
      ...(wholesale && { wholesaleBase }),
      ...(wholesale && wholesaleSale !== null && { wholesaleSale }),
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
}
// =============================================
// HELPER: Build new product with variants
// =============================================
async function buildNewProductWithVariants(productName, productRows, variants) {
  const firstRow = productRows[0];
  
  // Generate unique slug
  let baseSlug = slugify(productName, { lower: true, strict: true });
  let slug = baseSlug;
  let counter = 1;
  
  while (await Product.findOne({ slug })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }
  
  // Find or create category
  const categorySlug = slugify(firstRow.category, { lower: true, strict: true });
  let category = await Category.findOne({ slug: categorySlug });
  if (!category) {
    category = await Category.create({
      name: firstRow.category,
      slug: categorySlug,
      status: "active",
      level: 0,
    });
  }
  
  // HSN, Tax, Fragile
  const finalHsnCode = firstRow.hsnCode?.trim().toUpperCase() || null;
  const finalTaxRate = firstRow.taxRate ? parseFloat(firstRow.taxRate) : null;
 const finalIsFragile = parseBoolean(firstRow.isFragile);
  
  const productObj = {
    name: productName,
    slug,
    title: firstRow.title || productName,
    description: firstRow.description || "",
    category: category._id,
    brand: firstRow.brand || "Generic",
    status: firstRow.status?.toLowerCase() || "draft",
    isFeatured: parseBoolean(firstRow.isfeatured),
    variants: variants,
    hsnCode: finalHsnCode,
    taxRate: finalTaxRate,
    isFragile: finalIsFragile,
    soldInfo: {
      enabled: parseBoolean(firstRow.soldEnabled),
      count: Number(firstRow.soldCount) || 0,
    },
    fomo: {
    enabled: parseBoolean(firstRow.fomoEnabled),
      type: firstRow.fomoType || "viewing_now",
      viewingNow: Number(firstRow.viewingNow) || 0,
      productLeft: Number(firstRow.productLeft) || 0,
      customMessage: firstRow.customMessage || "",
    },
  };
  
  // Generate SEO
  const seoData = generateSEOData({
    name: productObj.name,
    slug: productObj.slug,
    description: productObj.description,
    category: { name: category.name },
    variants: productObj.variants,
  });
  productObj.seo = seoData;
  
  return await Product.create(productObj);
}
// =============================================
// HELPER: Flush batch to database (FIXED - No updatedAt conflict)
// =============================================
async function flushBatch(batch, batchNumber, stats) {
  try {
    // ✅ FIX: Use insertMany for new products, separate update for existing
    const newProducts = [];
    const existingProducts = [];
    
    for (const product of batch) {
      const exists = await Product.findOne({ slug: product.slug });
      if (exists) {
        existingProducts.push(product);
      } else {
        newProducts.push(product);
      }
    }
    
    // Insert new products
    if (newProducts.length > 0) {
      await Product.insertMany(newProducts, { ordered: false });
      console.log(`✅ Batch ${batchNumber}: ${newProducts.length} new products inserted`);
    }
    
    // Update existing products individually (to avoid updatedAt conflict)
    for (const product of existingProducts) {
      try {
        await Product.updateOne(
          { slug: product.slug },
          { 
            $set: { 
              variants: product.variants,
              seo: product.seo,
              updatedAt: new Date()
            } 
          }
        );
      } catch (updateError) {
        console.log(`⚠️ Failed to update product ${product.name}:`, updateError.message);
        stats.failed.push({
          product: product.name,
          reason: updateError.message
        });
      }
    }
    
    if (existingProducts.length > 0) {
      console.log(`✅ Batch ${batchNumber}: ${existingProducts.length} products updated`);
    }
    
  } catch (error) {
    console.log(`⚠️ Batch ${batchNumber} failed: ${error.message}`);
    
    // Individual inserts for failed
    for (const product of batch) {
      try {
        await Product.create(product);
      } catch (individualError) {
        console.log(`❌ Failed to process product: ${product.name}`, individualError.message);
        stats.failed.push({
          product: product.name,
          reason: individualError.message
        });
      }
    }
  }
}

// =============================================
// HELPER: Generate error report CSV with download URL
// =============================================
// =============================================
// HELPER: Generate error report CSV with download URL
// =============================================
async function generateErrorReport(failedItems, req = null) {
  const { Parser } = require('json2csv');
  
  const parser = new Parser({
    fields: ['product', 'reason', 'rows', 'timestamp']
  });
  
  const reportData = failedItems.map(item => ({
    product: item.product,
    reason: item.reason,
    rows: item.rows ? item.rows.join(', ') : 'N/A',
    timestamp: new Date().toISOString()
  }));
  
  const csvData = parser.parse(reportData);
  const fileName = `failed-import-${Date.now()}.csv`;
  const filePath = path.join(__dirname, '../uploads', fileName);
  
  fs.writeFileSync(filePath, csvData);
  console.log(`📄 Error report generated: ${filePath}`);
  
  // Generate download URL if req is provided
  let downloadUrl = null;
  if (req) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    // ✅ FIX: Match your actual route
    downloadUrl = `${baseUrl}/api/admin/products/download-error-report/${fileName}`;
    console.log(`🔗 Download URL: ${downloadUrl}`);
  }
  
  return {
    path: `/uploads/${fileName}`,
    downloadUrl: downloadUrl,
    fileName: fileName,
    fullPath: filePath
  };
}




// =============================================
// DOWNLOAD ERROR REPORT API (Common for both controllers)
// =============================================
const downloadErrorReport = async (req, res) => {
  try {
    const { fileName } = req.params;
    
    // ✅ Security: Allow both types of error reports
    if (!fileName || !fileName.endsWith('.csv')) {
      return res.status(400).json({
        success: false,
        message: "Invalid file format. Only CSV files allowed."
      });
    }
    
    // ✅ Check if it's a valid error report (either failed-import or failed-upload)
    if (!fileName.startsWith('failed-import-') && !fileName.startsWith('failed-upload-')) {
      return res.status(400).json({
        success: false,
        message: "Invalid error report file name"
      });
    }
    
    const filePath = path.join(__dirname, '../uploads', fileName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: "Error report not found or already deleted"
      });
    }
    
    // Send file for download
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error("Download error:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to download file"
        });
      }
      
      // Optional: Delete file after successful download (cleanup)
      // setTimeout(() => {
      //   if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      // }, 60 * 60 * 1000); // Delete after 1 hour
    });
    
  } catch (error) {
    console.error("Download error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to download error report",
      error: error.message
    });
  }
};



////////=================================
//=================================
//=================================
// NEW PRORDUCTS UPLOADS WITH ZIP AND CSV
//=================================
//=================================
///////===================================

//Bulk ypload from CSV with images in ZIP

// =============================================
// HELPER: Upload single image with retry
// =============================================
async function uploadSingleImageWithRetry(filePath, productName, barcode, index, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const buffer = fs.readFileSync(filePath);
      const upload = await uploadToCloudinary(
        buffer,
        "products",
        `${productName}-${barcode}-${index}-${Date.now()}`
      );
      return {
        url: upload.url,
        publicId: upload.publicId,
        altText: productName,
        order: index
      };
    } catch (err) {
      console.log(`⚠️ Upload attempt ${attempt} failed for ${filePath}: ${err.message}`);
      if (attempt === maxRetries) {
        throw new Error(`Failed to upload image after ${maxRetries} attempts: ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// =============================================
// HELPER: Upload variant images with concurrency limit
// =============================================
async function uploadVariantImages(imageFolder, productName, barcode, concurrencyLimit = 5) {
  if (!fs.existsSync(imageFolder)) {
    throw new Error(`Image folder not found for barcode ${barcode}`);
  }

  const files = fs.readdirSync(imageFolder).filter(file => 
    /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
  );

  if (!files.length) {
    throw new Error(`No valid images found for barcode ${barcode}`);
  }

  // Limit to max 10 images per variant
  const filesToUpload = files.slice(0, 10);
  
  const results = [];
  const batches = [];
  
  // Create batches with concurrency limit
  for (let i = 0; i < filesToUpload.length; i += concurrencyLimit) {
    batches.push(filesToUpload.slice(i, i + concurrencyLimit));
  }
  
  for (const batch of batches) {
    const batchPromises = batch.map((file, idx) => {
      const filePath = path.join(imageFolder, file);
      const globalIndex = results.length;
      return uploadSingleImageWithRetry(filePath, productName, barcode, globalIndex);
    });
    
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }
  
  return results;
}

// =============================================
// HELPER: Build variant with complete validation
// =============================================
async function buildCompleteVariant(row, productName, images) {
  // Validate barcode
  const barcode = Number(row.barcode);
  if (isNaN(barcode)) {
    throw new Error(`Invalid barcode: ${row.barcode}`);
  }
  
  // Check for duplicate barcode in database
  const existingVariant = await Product.findOne({
    'variants.barcode': barcode
  });
  
  if (existingVariant) {
    throw new Error(`Barcode ${barcode} already exists in product "${existingVariant.name}"`);
  }
  
  // Parse and validate price
  const basePrice = Number(row.basePrice);
  if (isNaN(basePrice) || basePrice <= 0) {
    throw new Error(`Invalid basePrice: ${row.basePrice}. Must be a positive number`);
  }
  
  const salePrice = row.salePrice && row.salePrice.trim() ? Number(row.salePrice) : null;
  if (salePrice !== null && (isNaN(salePrice) || salePrice <= 0)) {
    throw new Error(`Invalid salePrice: ${row.salePrice}. Must be a positive number`);
  }
  
  if (salePrice !== null && salePrice >= basePrice) {
    throw new Error(`Sale price (${salePrice}) must be less than base price (${basePrice})`);
  }
  
  // ✅ WHOLESALE HANDLING
  const wholesale = parseBoolean(row.wholesale);
  let wholesaleBase = null;
  let wholesaleSale = null;
  let minimumOrderQuantity = 1;
  
  if (wholesale) {
    if (!row.wholesaleBase || row.wholesaleBase.trim() === "") {
      throw new Error(`wholesaleBase is required when wholesale=true for barcode ${barcode}`);
    }
    
    wholesaleBase = Number(row.wholesaleBase);
    if (isNaN(wholesaleBase) || wholesaleBase <= 0) {
      throw new Error(`Invalid wholesaleBase: ${row.wholesaleBase}. Must be a positive number`);
    }
    
    if (row.wholesaleSale && row.wholesaleSale.trim() !== "") {
      wholesaleSale = Number(row.wholesaleSale);
      if (isNaN(wholesaleSale) || wholesaleSale <= 0) {
        throw new Error(`Invalid wholesaleSale: ${row.wholesaleSale}. Must be a positive number`);
      }
      
      if (wholesaleSale >= wholesaleBase) {
        throw new Error(`wholesaleSale (${wholesaleSale}) must be less than wholesaleBase (${wholesaleBase})`);
      }
    }
    
    minimumOrderQuantity = row.minimumOrderQuantity && Number(row.minimumOrderQuantity) > 0 
      ? Number(row.minimumOrderQuantity) 
      : 1;
      
    if (minimumOrderQuantity < 1) {
      throw new Error(`minimumOrderQuantity must be at least 1 for barcode ${barcode}`);
    }
  }
  
  // Parse attributes
  const parseAttributes = (attrString) => {
    if (!attrString) return [];
    return attrString.split("|").map(item => {
      const [key, value] = item.split(":");
      return { key: key?.trim(), value: value?.trim() };
    }).filter(attr => attr.key && attr.value);
  };
  
  const variantAttributes = parseAttributes(row.variantAttributes);
  
  // Generate SKU
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 10000);
  const sku = row.sku?.trim() || `SKU-${barcode}`;
  
  return {
    sku,
    barcode,
    wholesale,
    attributes: variantAttributes,
    weight: Number(row.weight) || 0,
    dimensions: {
      length: Number(row.length) || 0,
      width: Number(row.width) || 0,
      height: Number(row.height) || 0,
    },
    price: {
      base: basePrice,
      sale: salePrice,
      ...(wholesale && { wholesaleBase }),
      ...(wholesale && wholesaleSale !== null && { wholesaleSale }),
    },
    minimumOrderQuantity,
    inventory: {
      quantity: Number(row.quantity) || 0,
      trackInventory: true,
      lowStockThreshold: 5,
    },
    images: images,
    isActive: true,
  };
}

// =============================================
// MAIN CONTROLLER: Bulk upload with ZIP
// =============================================
const bulkUploadNewProductsWithImages = async (req, res) => {
  let csvPath = null;
  let zipPath = null;
  let extractPath = null;
  
  try {
    if (!req.files?.csvFile || !req.files?.imagesZip) {
      return res.status(400).json({
        success: false,
        message: "CSV file and images ZIP are required"
      });
    }

    csvPath = req.files.csvFile[0].path;
    zipPath = req.files.imagesZip[0].path;
    extractPath = path.join(__dirname, "../uploads/extracted");

    // Clean and create extract folder
    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }
    fs.mkdirSync(extractPath, { recursive: true });

    // Extract ZIP
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractPath, true);

    const extractedFolders = fs.readdirSync(extractPath);
    const rootFolder = extractedFolders.length === 1 && fs.statSync(path.join(extractPath, extractedFolders[0])).isDirectory()
      ? path.join(extractPath, extractedFolders[0])
      : extractPath;

    // Parse CSV
    const rows = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
        .on("data", (data) => {
          // Trim all string values
          Object.keys(data).forEach(key => {
            if (typeof data[key] === 'string') {
              data[key] = data[key].trim();
            }
          });
          rows.push(data);
        })
        .on("end", resolve)
        .on("error", reject);
    });

    console.log(`📊 Total rows in CSV: ${rows.length}`);

    const stats = {
      total: rows.length,
      successful: 0,
      failed: 0,
      errors: [],
      products: []
    };

    const BATCH_SIZE = 50;
    const BATCH_DELAY_MS = 1000;

    // =============================================
    // Process products (SYNCHRONOUSLY)
    // =============================================
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      
      console.log(`🔄 Processing batch ${batchNumber}/${Math.ceil(rows.length / BATCH_SIZE)} (${batch.length} products)`);
      
      const batchPromises = batch.map(async (row) => {
        try {
          const barcode = Number(row.barcode);
          
          if (isNaN(barcode)) {
            throw new Error(`Invalid barcode: ${row.barcode}`);
          }

          // Validate category
          const categoryDoc = await Category.findOne({ 
            name: { $regex: new RegExp(`^${row.category}$`, 'i') }
          });
          
          if (!categoryDoc) {
            throw new Error(`Category not found: ${row.category}`);
          }

          // Upload images from barcode folder
          const imageFolder = path.join(rootFolder, String(barcode));
          const variantImages = await uploadVariantImages(imageFolder, row.name, barcode);

          // Build complete variant with wholesale
          const newVariant = await buildCompleteVariant(row, row.name, variantImages);

          // Check if product exists
          let product = await Product.findOne({ 
            name: { $regex: new RegExp(`^${row.name}$`, 'i') }
          });

          // Parse product-level fields
          const finalHsnCode = row.hsnCode?.trim().toUpperCase() || null;
          const finalTaxRate = row.taxRate ? parseFloat(row.taxRate) : null;
          const finalIsFragile = parseBoolean(row.isFragile);
          const parseAttributes = (attrString) => {
            if (!attrString) return [];
            return attrString.split("|").map(item => {
              const [key, value] = item.split(":");
              return { key: key?.trim(), value: value?.trim() };
            }).filter(attr => attr.key && attr.value);
          };
          const productAttributes = parseAttributes(row.productAttributes);

          if (product) {
            // Check for duplicate variant attributes
            const variantExists = product.variants.some(v => 
              JSON.stringify(v.attributes) === JSON.stringify(newVariant.attributes)
            );
            
            if (variantExists) {
              throw new Error(`Variant with same attributes already exists for product ${row.name}`);
            }
            
            product.variants.push(newVariant);
            
            // Update product-level fields if not set
            if (finalHsnCode && !product.hsnCode) product.hsnCode = finalHsnCode;
            if (finalTaxRate !== null && !product.taxRate) product.taxRate = finalTaxRate;
            if (finalIsFragile && !product.isFragile) product.isFragile = finalIsFragile;
            if (productAttributes.length && !product.attributes?.length) {
              product.attributes = productAttributes;
            }
            
            await product.save();
            stats.successful++;
            stats.products.push({ name: row.name, barcode, action: 'updated' });
          } else {
            // Create new product
            const slug = await generateSlug(row.name);
            
            // Generate SEO
            const seoData = generateSEOData({
              name: row.name,
              title: row.title || row.name,
              description: row.description || '',
              category: { name: categoryDoc.name },
              variants: [newVariant]
            });
            
            product = new Product({
              name: row.name,
              title: row.title || row.name,
              slug,
              description: row.description || "",
              category: categoryDoc._id,
              brand: row.brand || "Generic",
              status: row.status?.toLowerCase() || "active",
              isFeatured: parseBoolean(row.isfeatured),
              attributes: productAttributes,
              variants: [newVariant],
              seo: seoData,
              hsnCode: finalHsnCode,
              taxRate: finalTaxRate,
              isFragile: finalIsFragile,
              soldInfo: {
                enabled: parseBoolean(row.soldEnabled),
                count: Number(row.soldCount) || 0,
              },
              fomo: {
                enabled: parseBoolean(row.fomoEnabled),
                type: row.fomoType || "viewing_now",
                viewingNow: Number(row.viewingNow) || 0,
                productLeft: Number(row.productLeft) || 0,
                customMessage: row.customMessage || "",
              }
            });
            
            await product.save();
            stats.successful++;
            stats.products.push({ name: row.name, barcode, action: 'inserted' });
          }
          
        } catch (err) {
          stats.failed++;
          stats.errors.push({
            row: row.name || "Unknown",
            barcode: row.barcode,
            error: err.message
          });
          console.error(`❌ Failed to process ${row.name}:`, err.message);
        }
      });
      
      await Promise.all(batchPromises);
      
      if (i + BATCH_SIZE < rows.length) {
        console.log(`⏳ Waiting ${BATCH_DELAY_MS}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
      
      console.log(`📊 Batch ${batchNumber} completed. Success: ${stats.successful}, Failed: ${stats.failed}`);
    }

    // =============================================
    // Generate error report if any failures
    // =============================================
    let errorReportUrl = null;
    
    if (stats.errors.length > 0) {
      const { Parser } = require('json2csv');
      const parser = new Parser({ fields: ["row", "barcode", "error"] });
      const csvData = parser.parse(stats.errors);
      const fileName = `failed-upload-${Date.now()}.csv`;
      const errorReportPath = path.join(__dirname, "../uploads", fileName);
      fs.writeFileSync(errorReportPath, csvData);
      console.log(`📄 Error report generated: ${errorReportPath}`);
      
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      errorReportUrl = `${baseUrl}/api/admin/products/download-error-report/${fileName}`;
      console.log(`🔗 Download URL: ${errorReportUrl}`);
    }

    // Cleanup
    if (csvPath && fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (extractPath && fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }

    console.log(`\n🎉 BULK UPLOAD COMPLETED!`);
    console.log(`✅ Successful: ${stats.successful}`);
    console.log(`❌ Failed: ${stats.failed}`);

    // =============================================
    // Send FINAL response with download link
    // =============================================
    return res.status(200).json({
      success: true,
      message: "Bulk upload completed",
      totalRows: rows.length,
      successful: stats.successful,
      failed: stats.failed,
      downloadUrl: errorReportUrl  // ✅ Direct download link in response
    });
    
  } catch (error) {
    console.error("Bulk upload error:", error);
    // Cleanup on error
    if (csvPath && fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
    if (zipPath && fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    if (extractPath && fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true, force: true });
    }
    
    return res.status(500).json({
      success: false,
      message: "Bulk upload failed",
      error: error.message
    });
  }
};







//update product or variant
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
    // ✅ NEW: VALIDATE HSN CODE
    // =====================================================
    if (updates.hsnCode !== undefined) {
      if (updates.hsnCode && updates.hsnCode.trim()) {
        const trimmedHsn = updates.hsnCode.trim().toUpperCase();
        if (trimmedHsn.length > 20) {
          return res.status(400).json({
            success: false,
            message: "HSN code cannot exceed 20 characters"
          });
        }
        updates.hsnCode = trimmedHsn;
      } else {
        updates.hsnCode = null;
      }
    }

    // =====================================================
    // ✅ NEW: VALIDATE TAX RATE
    // =====================================================
    if (updates.taxRate !== undefined) {
      if (updates.taxRate !== null && updates.taxRate !== "") {
        const parsedTaxRate = Number(updates.taxRate);
        if (isNaN(parsedTaxRate) || parsedTaxRate < 0) {
          return res.status(400).json({
            success: false,
            message: "Tax rate must be a valid number greater than or equal to 0"
          });
        }
        updates.taxRate = parsedTaxRate;
      } else {
        updates.taxRate = null;
      }
    }

    // =====================================================
    // ✅ NEW: VALIDATE FRAGILE FLAG
    // =====================================================
    if (updates.isFragile !== undefined) {
      updates.isFragile = updates.isFragile === true || updates.isFragile === "true";
    }

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

    // =====================================================
    // ✅ REGENERATE SEO if name or description changed
    // =====================================================
    if (updates.name || updates.description) {
      // Fetch category for SEO
      const categoryDoc = await Category.findById(existingProduct.category).lean();
      
      // Prepare product data for SEO generation
      const productDataForSEO = {
        name: updates.name || existingProduct.name,
        description: updates.description || existingProduct.description,
        category: categoryDoc ? { name: categoryDoc.name } : null,
        variants: existingProduct.variants
      };
      
      // Generate fresh SEO data
      const seoData = generateSEOData(productDataForSEO);
      
      // Add to updates
      updates.seo = seoData;
    }

    // =====================================================
    // ✅ REGENERATE SEO if hsnCode or taxRate changed (optional but good for meta keywords)
    // =====================================================
    if (updates.hsnCode !== undefined || updates.taxRate !== undefined) {
      const categoryDoc = await Category.findById(existingProduct.category).lean();
      
      const productDataForSEO = {
        name: updates.name || existingProduct.name,
        description: updates.description || existingProduct.description,
        category: categoryDoc ? { name: categoryDoc.name } : null,
        variants: existingProduct.variants,
        // Pass new fields for SEO (can be used in generateSEOData if needed)
        hsnCode: updates.hsnCode !== undefined ? updates.hsnCode : existingProduct.hsnCode,
        taxRate: updates.taxRate !== undefined ? updates.taxRate : existingProduct.taxRate
      };
      
      const seoData = generateSEOData(productDataForSEO);
      updates.seo = seoData;
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

// const updateProduct = async (req, res) => {
//   try {

//     const slug = req.params.slug;

//     const existingProduct = await Product.findOne({ slug });

//     if (!existingProduct) {
//       return res.status(404).json({
//         success: false,
//         message: "Product not found"
//       });
//     }

//     const updates = { ...req.body };

//     delete updates.slug;
//     delete updates.sku;
//     delete updates.variants;

//     const parseIfString = (value, fallback) => {
//       if (typeof value === "string") {
//         try {
//           return JSON.parse(value);
//         } catch {
//           return fallback;
//         }
//       }
//       return value;
//     };

//     // =====================================================
//     // ✅ VARIANT UPDATE BY BARCODE
//     // =====================================================

//     if (updates.barcode) {

//       const barcodeNumber = Number(updates.barcode);

//       if (isNaN(barcodeNumber)) {
//         return res.status(400).json({
//           success: false,
//           message: "Invalid barcode"
//         });
//       }

//       const variantIndex = existingProduct.variants.findIndex(
//         v => v.barcode === barcodeNumber
//       );

//       if (variantIndex === -1) {
//         return res.status(404).json({
//           success: false,
//           message: "No product found with this barcode"
//         });
//       }

//       const existingVariant = existingProduct.variants[variantIndex];

//       const updateFields = {};

//       // =========================
//       // PRICE UPDATE
//       // =========================

//       if (updates.price) {

//         const parsedPrice = parseIfString(updates.price, {});

//         const base =
//           parsedPrice.base !== undefined
//             ? Number(parsedPrice.base)
//             : existingVariant.price.base;

//         const sale =
//           parsedPrice.sale !== undefined
//             ? parsedPrice.sale != null
//               ? Number(parsedPrice.sale)
//               : null
//             : existingVariant.price.sale;

//         if (sale != null && sale >= base) {
//           return res.status(400).json({
//             success: false,
//             message: "Sale price must be less than base price"
//           });
//         }

//         if (parsedPrice.base !== undefined) {
//           updateFields["variants.$.price.base"] = base;
//         }

//         if (parsedPrice.sale !== undefined) {
//           updateFields["variants.$.price.sale"] = sale;
//         }
//       }

//       // =========================
//       // INVENTORY UPDATE
//       // =========================

//       if (updates.inventory) {

//         const parsedInventory = parseIfString(updates.inventory, {});

//         if (parsedInventory.quantity !== undefined) {
//           updateFields["variants.$.inventory.quantity"] =
//             Number(parsedInventory.quantity);
//         }

//         if (parsedInventory.lowStockThreshold !== undefined) {
//           updateFields["variants.$.inventory.lowStockThreshold"] =
//             Number(parsedInventory.lowStockThreshold);
//         }

//         if (parsedInventory.trackInventory !== undefined) {
//           updateFields["variants.$.inventory.trackInventory"] =
//             parsedInventory.trackInventory;
//         }
//       }

//       // =========================
//       // ✅ IMAGES UPDATE (FIXED)
//       // =========================

//       if (req.files && req.files.length > 0) {

//         // delete old images
//         if (existingVariant.images && existingVariant.images.length > 0) {

//           for (const img of existingVariant.images) {

//             if (img.publicId) {
//               await deleteFromCloudinary(img.publicId);
//             }

//           }

//         }

//         const uploadedImages = [];

//         for (let i = 0; i < req.files.length; i++) {

//           const file = req.files[i];

//           // ensure buffer exists
//           if (!file.buffer) {
//             continue;
//           }

//           const uploadResult = await uploadToCloudinary(
//             file.buffer,
//             "products"
//           );

//           uploadedImages.push({
//             url: uploadResult.url,
//             publicId: uploadResult.publicId,
//             altText: existingProduct.name,
//             order: i
//           });

//         }

//         updateFields["variants.$.images"] = uploadedImages;

//       }

//       const updatedProduct = await Product.findOneAndUpdate(
//         { slug, "variants.barcode": barcodeNumber },
//         { $set: updateFields },
//         { new: true }
//       );

//       // 🔁 Recalculate totals
//       const effectivePrices = updatedProduct.variants.map(v =>
//         v.price.sale != null ? v.price.sale : v.price.base
//       );

//       updatedProduct.priceRange = {
//         min: Math.min(...effectivePrices),
//         max: Math.max(...effectivePrices)
//       };

//       updatedProduct.totalStock =
//         updatedProduct.variants.reduce(
//           (sum, v) => sum + (v.inventory.quantity || 0),
//           0
//         );

//       await updatedProduct.save();

//       return res.status(200).json({
//         success: true,
//         message: "Variant updated successfully",
//         product: updatedProduct
//       });

//     }

//     // =====================================================
//     // PRODUCT FIELD UPDATE
//     // =====================================================

//     if (updates.name && updates.name !== existingProduct.name) {

//       updates.slug = await generateSlug(
//         updates.name,
//         existingProduct._id
//       );

//     }

//     if (updates.soldInfo) {

//       const parsed = parseIfString(updates.soldInfo, {});

//       updates.soldInfo = {
//         ...existingProduct.soldInfo.toObject(),
//         ...parsed,
//         enabled: parsed.enabled === true || parsed.enabled === "true",
//         count: Number(parsed.count ?? 0)
//       };

//     }

//     if (updates.fomo) {

//       const parsed = parseIfString(updates.fomo, {});

//       updates.fomo = {
//         ...existingProduct.fomo.toObject(),
//         ...parsed,
//         enabled: parsed.enabled === true || parsed.enabled === "true",
//         viewingNow: Number(parsed.viewingNow ?? 0),
//         productLeft: Number(parsed.productLeft ?? 0),
//         type: ["viewing_now", "product_left", "custom"].includes(parsed.type)
//           ? parsed.type
//           : existingProduct.fomo.type
//       };

//     }

//     if (updates.shipping) {

//       const parsed = parseIfString(updates.shipping, {});

//       updates.shipping = {
//         ...existingProduct.shipping.toObject(),
//         ...parsed,
//         weight: Number(parsed.weight ?? 0),
//         dimensions: {
//           length: Number(parsed.dimensions?.length ?? 0),
//           width: Number(parsed.dimensions?.width ?? 0),
//           height: Number(parsed.dimensions?.height ?? 0)
//         }
//       };

//     }

//     if (updates.attributes) {      

//       const parsed = parseIfString(updates.attributes, []);

//       updates.attributes = Array.isArray(parsed)
//         ? parsed.map(a => ({ key: a.key, value: a.value }))
//         : [];

//     }

//       // =====================================================
//     // ✅ ADD THIS BLOCK: Regenerate SEO if name or description changed
//     // =====================================================
//     if (updates.name || updates.description) {
//       // Fetch category for SEO
//       const categoryDoc = await Category.findById(existingProduct.category).lean();
      
//       // Prepare product data for SEO generation
//       const productDataForSEO = {
//         name: updates.name || existingProduct.name,
//         description: updates.description || existingProduct.description,
//         category: categoryDoc ? { name: categoryDoc.name } : null,
//         variants: existingProduct.variants  // Use existing variants
//       };
      
//       // Generate fresh SEO data
//       const seoData = generateSEOData(productDataForSEO);
      
//       // Add to updates
//       updates.seo = seoData;
//     }



//     const updatedProduct = await Product.findByIdAndUpdate(
//       existingProduct._id,
//       { $set: updates },
//       { new: true, runValidators: true }
//     );

//     return res.status(200).json({
//       success: true,
//       message: "Product updated successfully",
//       product: updatedProduct
//     });

//   } catch (error) {

//     console.error("Update product error:", error);

//     return res.status(500).json({
//       success: false,
//       message: "Error updating product",
//       error: error.message
//     });

//   }
// };













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
             // =============================
        // ✅ FALLBACK: If no SEO data, generate on the fly
        // =============================
        if (!product.seo || !product.seo.meta_title) {
            const seoData = generateSEOData({
                name: product.name,
                description: product.description,
                category: product.category,
                variants: product.variants
            });
            product.seo = seoData;
            
            // Optionally update in database for next time
            await Product.updateOne(
                { _id: product._id },
                { $set: { seo: seoData } }
            );
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
    // Parse body safely - SAME as updateProduct
    // =========================
    let variant = { ...req.body };

    // Helper function to parse JSON strings (same as updateProduct)
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

    // Parse all potential JSON fields (same as updateProduct)
    if (variant.price) {
      variant.price = parseIfString(variant.price, {});
    }

    if (variant.attributes) {
      variant.attributes = parseIfString(variant.attributes, []);
    }

    if (variant.inventory) {
      variant.inventory = parseIfString(variant.inventory, {});
    }

    // Log parsed data for debugging
    console.log("Parsed variant data:", JSON.stringify(variant, null, 2));

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
    // 🔒 PRICE VALIDATION - Now works because price is parsed
    // =========================
    if (!variant.price?.base) {
      return res.status(400).json({
        success: false,
        message: "Base price is required"
      });
    }

    const basePrice = Number(variant.price.base);
    if (isNaN(basePrice) || basePrice <= 0) {
      return res.status(400).json({
        success: false,
        message: "Base price must be a valid number greater than 0"
      });
    }

    const salePrice = variant.price.sale != null
      ? Number(variant.price.sale)
      : null;

    if (salePrice !== null && (isNaN(salePrice) || salePrice >= basePrice)) {
      return res.status(400).json({
        success: false,
        message: "Sale price must be a valid number less than base price"
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

const newVariant = {
  sku: skuVal,
  barcode: barcodeNumber,

  wholesale: variant.wholesale === "true" || variant.wholesale === true,

  attributes: Array.isArray(variant.attributes)
    ? variant.attributes
        .filter(a => a.key && a.value)
        .map(a => ({
          key: a.key,
          value: a.value
        }))
    : [],

  price: {
    base: basePrice,
    sale: salePrice,
    wholesaleBase: variant.price.wholesaleBase
      ? Number(variant.price.wholesaleBase)
      : null,
    wholesaleSale: null
  },

  inventory: {
    quantity: Number(variant.inventory?.quantity || 0),
    lowStockThreshold: Number(variant.inventory?.lowStockThreshold || 5),
    trackInventory: variant.inventory?.trackInventory !== false
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
        hsnCode: 1,
        taxRate: 1,
        isFragile: 1,
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
        soldInfo: product.soldInfo,
        hsnCode: product.hsnCode,
        taxRate: product.taxRate,
        isFragile: product.isFragile
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
// const getProductDetails = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const product = await Product.findById(id).populate('category');
//     if (!product) return res.status(404).json({ message: 'Product not found' });

//     let price;
//     if (req.userType === 'wholesaler') {
//       price = {
//         base: product.price.wholesaleBase,
//         sale: product.price.wholesaleSale || product.price.wholesaleBase,
//         minimumOrderQuantity: product.minimumOrderQuantity
//       };
//     } else {
//       price = {
//         base: product.price.base,
//         sale: product.price.sale || product.price.base
//       };
//     }

//     res.status(200).json({
//       product,
//       price
//     });
//   } catch (error) {
//     res.status(500).json({ message: 'Error fetching product details', error });
//   }
// };



//will have to test it 
const updateVariant = async (req, res) => {
  try {
    const { slug, variantId } = req.params;

    const product = await Product.findOne({ slug });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    const variant = product.variants.id(variantId);

    if (!variant) {
      return res.status(404).json({
        success: false,
        message: "Variant not found"
      });
    }

    // =========================
    // 🔧 HELPERS
    // =========================
    const parseBoolean = (val) => {
      if (typeof val === "boolean") return val;
      if (typeof val === "string") return val.toLowerCase() === "true";
      return false;
    };

    const parseNumber = (val) => {
      const num = Number(val);
      return isNaN(num) ? null : num;
    };

    // =========================
    // 📦 UPDATE BASIC FIELDS
    // =========================
    if (req.body.barcode) {
      const barcodeNumber = Number(req.body.barcode);

      const exists = await Product.exists({
        "variants.barcode": barcodeNumber,
        "variants._id": { $ne: variantId }
      });

      if (exists) {
        return res.status(400).json({
          success: false,
          message: "Barcode already exists"
        });
      }

      variant.barcode = barcodeNumber;
    }

    // =========================
    // 💰 PRICE UPDATE
    // =========================
    const base = parseNumber(req.body["price[base]"]);
    const sale = parseNumber(req.body["price[sale]"]);
    const wholesaleBase = parseNumber(req.body["price[wholesaleBase]"]);
    const wholesaleSale = parseNumber(req.body["price[wholesaleSale]"]);

    if (base !== null) {
      if (base <= 0) {
        return res.status(400).json({
          success: false,
          message: "Base price must be greater than 0"
        });
      }
      variant.price.base = base;
    }

    if (sale !== null) {
      if (sale >= variant.price.base) {
        return res.status(400).json({
          success: false,
          message: "Sale price must be less than base price"
        });
      }
      variant.price.sale = sale;
    }

    if (wholesaleBase !== null) {
      variant.price.wholesaleBase = wholesaleBase;
    }

    if (wholesaleSale !== null) {
      variant.price.wholesaleSale = wholesaleSale;
    }

    // =========================
    // 📦 INVENTORY UPDATE
    // =========================
    if (req.body.quantity !== undefined) {
      variant.inventory.quantity = parseNumber(req.body.quantity) || 0;
    }

    if (req.body.lowStockThreshold !== undefined) {
      variant.inventory.lowStockThreshold =
        parseNumber(req.body.lowStockThreshold) || 5;
    }

    if (req.body.trackInventory !== undefined) {
      variant.inventory.trackInventory = parseBoolean(
        req.body.trackInventory
      );
    }

    // =========================
    // 🏷️ WHOLESALE FLAG
    // =========================
    if (req.body.wholesale !== undefined) {
      variant.wholesale = parseBoolean(req.body.wholesale);
    }

    // =========================
    // 📦 MOQ
    // =========================
    if (req.body.minimumOrderQuantity !== undefined) {
      variant.minimumOrderQuantity =
        parseNumber(req.body.minimumOrderQuantity) || 1;
    }

    // =========================
    // 🎯 ACTIVE FLAG
    // =========================
    if (req.body.isActive !== undefined) {
      variant.isActive = parseBoolean(req.body.isActive);
    }

    // =========================
    // 🧩 ATTRIBUTES
    // =========================
    if (req.body.attributes) {
      try {
        const parsed = JSON.parse(req.body.attributes);

        variant.attributes = parsed.map((a) => ({
          key: a.key,
          value: a.value
        }));
      } catch (e) {
        return res.status(400).json({
          success: false,
          message: "Invalid attributes format"
        });
      }
    }

    // =========================
    // 📸 IMAGE HANDLING
    // =========================
    if (req.files && req.files.length > 0) {
      // delete old images (optional)
      for (let img of variant.images) {
        if (img.publicId) {
          await cloudinary.uploader.destroy(img.publicId);
        }
      }

      let uploadedImages = [];

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];

        const upload = await uploadToCloudinary(
          file.buffer,
          "products"
        );

        uploadedImages.push({
          url: upload.url,
          publicId: upload.publicId,
          altText: product.name,
          order: i
        });
      }

      variant.images = uploadedImages;
    }

    // =========================
    // 🔁 RECALCULATE PRODUCT
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
      message: "Variant updated successfully",
      variant
    });

  } catch (error) {
    console.error("Update variant error:", error);

    return res.status(500).json({
      success: false,
      message: "Error updating variant",
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
  getAllActiveProducts,
  getProductBySlug ,
   bulkRestore  , 
   importProductsFromCSV ,
   getAllProductsAdmin , 
   addVariant,
   deleteVariant,
   getVariantByBarcode,
   bulkUploadNewProductsWithImages,
   downloadErrorReport
};
