const { cloudinary } = require('../config/cloudinary.config');
const Product  = require('../models/Product');
const Category = require('../models/Category');
const mongoose = require('mongoose');
const slugify  = require('slugify');
const { generateSlug, generateSku } = require('../utils/productUtils');
const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinaryHelper');
const sharp    = require('sharp');
const fs       = require('fs');
const fsp      = require('fs').promises;
const csv      = require('csv-parser');
const unzipper = require('unzipper');
const path     = require('path');
const axios    = require('axios');
const os       = require('os');
const xlsx     = require('xlsx');

// ─────────────────────────────────────────────────────────────
// BULK UPLOAD — CONSTANTS
// ─────────────────────────────────────────────────────────────
const MAX_IMAGES       = 5;
const BATCH_SIZE       = 5;
const MAX_RETRY        = 2;
const VALID_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SKIP_DIRS        = new Set(['__macosx', '.ds_store', 'thumbs.db', '.git', 'node_modules']);

// ─────────────────────────────────────────────────────────────
// LOGGING HELPER — always logs with context so you can trace
// ─────────────────────────────────────────────────────────────
const log = {
  info : (...a) => console.log ('[BULK]', ...a),
  warn : (...a) => console.warn('[BULK][WARN]', ...a),
  error: (...a) => console.error('[BULK][ERR]', ...a),
  zip  : (...a) => console.log ('[BULK][ZIP]', ...a),
  cld  : (...a) => console.log ('[BULK][CDN]', ...a),
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/** Strip BOM + non-printable ASCII + trim + lowercase */
const normaliseKey = (raw) =>
  String(raw ?? '')
    .replace(/^\uFEFF/, '')          // Excel BOM
    .replace(/[^\x20-\x7E]/g, '')   // non-printable
    .trim()
    .toLowerCase();

/** Parse CSV / XLS / XLSX → array of plain objects, all keys lowercased */
const parseSpreadsheet = (filePath) => {
  const wb   = xlsx.readFile(filePath, { raw: false, defval: '' });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[normaliseKey(k)] = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
    }
    return out;
  });
};

/** "Color:Black|Size:L" → [{key,value}] */
const parseAttrs = (raw) => {
  if (!raw) return [];
  return String(raw).split('|').map((p) => {
    const [k, ...rest] = p.split(':');
    return { key: (k || '').trim(), value: rest.join(':').trim() };
  }).filter((a) => a.key && a.value);
};

/** "url1, url2" → ['url1','url2'] capped at MAX_IMAGES */
const parseUrls = (raw) =>
  String(raw || '').split(',').map((u) => u.trim()).filter(Boolean).slice(0, MAX_IMAGES);

/** Group flat spreadsheet rows → products with variants[] */
const groupRows = (rows) => {
  const map   = new Map();
  const order = [];

  rows.forEach((row, idx) => {
    const name = (row.name || '').trim();
    if (!name) return;

    if (!map.has(name)) {
      order.push(name);
      map.set(name, {
        name,
        title            : (row.title || name).trim(),
        description      : (row.description || '').trim(),
        category         : (row.category || '').trim(),
        brand            : (row.brand || 'Generic').trim(),
        status           : (row.status || 'draft').toLowerCase(),
        isFeatured       : row.isfeatured === 'true',
        productAttributes: parseAttrs(row.productattributes || row.productAttributes || ''),
        soldInfo: {
          enabled: (row.soldenabled || row.soldEnabled || '') === 'true',
          count  : Number(row.soldcount || row.soldCount || 0),
        },
        fomo: {
          enabled      : (row.fomoenabled || row.fomoEnabled || '') === 'true',
          type         : (row.fomotype || row.fomoType || 'viewing_now').trim(),
          viewingNow   : Number(row.viewingnow   || row.viewingNow   || 0),
          productLeft  : Number(row.productleft  || row.productLeft  || 0),
          customMessage: (row.custommessage || row.customMessage || '').trim(),
        },
        shipping: {
          weight    : Number(row.weight || 0),
          dimensions: {
            length: Number(row.length || 0),
            width : Number(row.width  || 0),
            height: Number(row.height || 0),
          },
        },
        variants: [],
      });
    }

    const base = Number((row.baseprice || row.basePrice || '').replace(/[^0-9.]/g, '') || 0);
    const sale = (row.saleprice || row.salePrice)
      ? Number((row.saleprice || row.salePrice).replace(/[^0-9.]/g, '') || 0)
      : null;

    map.get(name).variants.push({
      barcode          : String(row.barcode || '').trim(),
      imageUrls        : parseUrls(row.images || ''),
      variantAttributes: parseAttrs(row.variantattributes || row.variantAttributes || ''),
      price            : { base, sale },
      inventory: {
        quantity         : Number(row.quantity || 0),
        trackInventory   : (row.trackinventory || 'true') !== 'false',
        lowStockThreshold: Number(row.lowstockthreshold || 5),
      },
      isActive: (row.isactive || 'true') !== 'false',
      _row    : idx + 2,
    });
  });

  return order.map((n) => map.get(n));
};

/** Returns [] if product is valid, else array of error strings */
const validateProduct = (prod) => {
  const e = [];
  if (!prod.name)     e.push('name is required');
  if (!prod.category) e.push('category is required');
  prod.variants.forEach((v, i) => {
    if (!v.price.base || v.price.base <= 0)
      e.push(`variant ${i + 1} (row ${v._row}): basePrice must be > 0`);
    if (v.price.sale !== null && v.price.sale >= v.price.base)
      e.push(`variant ${i + 1} (row ${v._row}): salePrice must be less than basePrice`);
  });
  return e;
};

// ── Cloudinary upload from local file path (Mode B) ──────────
const uploadFileCld = async (filePath, publicId, attempt = 1) => {
  try {
    log.cld(`Uploading file → Cloudinary: ${path.basename(filePath)} as ${publicId} (attempt ${attempt})`);
    const r = await cloudinary.uploader.upload(filePath, {
      public_id: publicId, folder: 'products/bulk', overwrite: true,
    });
    log.cld(`✓ Uploaded: ${publicId} → ${r.secure_url}`);
    return { ok: true, url: r.secure_url, publicId: r.public_id };
  } catch (err) {
    log.error(`Cloudinary file upload failed — publicId: ${publicId}, attempt: ${attempt}, error: ${err.message}`);
    if (attempt < MAX_RETRY) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return uploadFileCld(filePath, publicId, attempt + 1);
    }
    return { ok: false, error: err.message };
  }
};

// ── Cloudinary upload from remote URL (Mode A) ───────────────
const uploadUrlCld = async (url, publicId, attempt = 1) => {
  try {
    log.cld(`Downloading URL: ${url.substring(0, 80)}… (attempt ${attempt})`);
    let dataUri = url;
    if (!url.startsWith('data:')) {
      const res = await axios.get(url, {
        responseType: 'arraybuffer', timeout: 60_000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const mime = res.headers['content-type'] || 'image/jpeg';
      dataUri = `data:${mime};base64,${Buffer.from(res.data).toString('base64')}`;
    }
    const r = await cloudinary.uploader.upload(dataUri, {
      public_id: publicId, folder: 'products/bulk', overwrite: true,
    });
    log.cld(`✓ URL uploaded: ${publicId}`);
    return { ok: true, url: r.secure_url, publicId: r.public_id };
  } catch (err) {
    log.error(`URL upload failed — url: ${url.substring(0, 80)}, attempt: ${attempt}, error: ${err.message}`);
    if (attempt < MAX_RETRY) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return uploadUrlCld(url, publicId, attempt + 1);
    }
    return { ok: false, error: err.message };
  }
};

/** Upload array of items (file paths or URLs) in parallel batches */
const batchUpload = async (items, uploadFn, barcodeKey) => {
  const results = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk   = items.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(
      chunk.map((item, j) => uploadFn(item, `bulk_${barcodeKey}_${i + j + 1}`))
    );
    settled.forEach((s) => {
      results.push(s.status === 'fulfilled' ? s.value : { ok: false, error: s.reason?.message });
    });
  }
  return results;
};

/**
 * Build barcode → absolute folder path map from an extracted ZIP directory.
 *
 * Handles ALL these real-world ZIP structures:
 *
 *   FLAT — user selected barcode folders and zipped them:
 *     extractDir/
 *       9016081/   ← barcode folders directly at root
 *       6096170/
 *       3622881/
 *
 *   WRAPPED — user zipped the parent folder (most common mistake):
 *     extractDir/
 *       warehouse/       ← one wrapper folder (any name)
 *         9016081/       ← barcode folders one level down
 *         6096170/
 *         3622881/
 *
 *   MULTI-WRAPPED — multiple wrapper folders (also supported):
 *     extractDir/
 *       category_a/
 *         9016081/
 *       category_b/
 *         6096170/
 *
 * Detection logic:
 *   A barcode folder name is purely numeric (e.g. "9016081").
 *   A wrapper folder name contains letters (e.g. "warehouse", "products").
 *   If NO root-level folder is purely numeric → assume wrapped, go 1 level deeper.
 *   If ANY root-level folder is purely numeric → treat as flat.
 */
const buildFolderMap = async (extractDir) => {
  log.zip(`Scanning extracted ZIP at: ${extractDir}`);

  const isSkippable = (name) =>
    SKIP_DIRS.has(name.toLowerCase()) || name.startsWith('.');

  /** Read immediate subdirectories of a given directory */
  const getSubDirs = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      log.error(`Cannot read directory ${dir}: ${e.message}`);
      return [];
    }
    return entries.filter(e => e.isDirectory() && !isSkippable(e.name));
  };

  /**
   * A folder is treated as a BARCODE folder if its name is:
   *   - purely numeric:          "9016081"
   *   - numeric with leading 0:  "0912345"
   *   - numeric with dashes:     "901-6081"  (some barcode formats)
   *
   * A folder is treated as a WRAPPER if its name contains letters,
   * e.g. "warehouse", "products", "batch1".
   *
   * We use PURELY NUMERIC test:  /^\d[\d-]*\d$|^\d+$/
   */
  const isPurelyNumeric = (name) => /^\d+$/.test(name.trim());

  const rootDirs = await getSubDirs(extractDir);

  log.zip(`Root-level directories (${rootDirs.length}): [${rootDirs.map(e => e.name).join(', ')}]`);

  if (rootDirs.length === 0) {
    log.warn('ZIP appears to have no directories at the root level. Nothing to process.');
    return new Map();
  }

  // Check if ANY root dir looks like a barcode (purely numeric name)
  const anyBarcodeAtRoot = rootDirs.some(e => isPurelyNumeric(e.name));

  const map = new Map();

  if (anyBarcodeAtRoot) {
    // FLAT structure — barcode folders are directly at root
    log.zip(`FLAT ZIP structure detected (barcode folders at root level).`);
    for (const entry of rootDirs) {
      const key = normaliseKey(entry.name);
      if (!map.has(key)) {
        map.set(key, path.join(extractDir, entry.name));
        log.zip(`  Mapped barcode "${key}" → ${entry.name}/`);
      } else {
        log.warn(`Duplicate barcode folder "${key}" at root — keeping first occurrence.`);
      }
    }
  } else {
    // WRAPPED structure — all root dirs are wrapper folders
    log.zip(`WRAPPED ZIP structure detected. Root wrapper(s): [${rootDirs.map(e => e.name).join(', ')}]`);
    log.zip(`Scanning one level deeper inside each wrapper folder…`);

    for (const wrapper of rootDirs) {
      const wrapperPath = path.join(extractDir, wrapper.name);
      const innerDirs   = await getSubDirs(wrapperPath);

      log.zip(`  Wrapper "${wrapper.name}" contains ${innerDirs.length} subfolder(s): [${innerDirs.map(e => e.name).join(', ')}]`);

      for (const inner of innerDirs) {
        const key = normaliseKey(inner.name);
        if (!map.has(key)) {
          map.set(key, path.join(wrapperPath, inner.name));
          log.zip(`    Mapped barcode "${key}" → ${wrapper.name}/${inner.name}/`);
        } else {
          log.warn(`Duplicate barcode folder "${key}" found in wrapper "${wrapper.name}" — keeping first occurrence.`);
        }
      }
    }
  }

  log.zip(`Total barcode folders mapped: ${map.size}`);
  if (map.size > 0) {
    log.zip(`Barcode keys available: [${[...map.keys()].join(', ')}]`);
  } else {
    log.warn('No barcode folders found after scanning ZIP. Check your folder structure.');
  }

  return map;
};

/** Get valid image file paths from a barcode folder, skip unsupported formats */
const getImages = async (folderPath) => {
  let files;
  try {
    files = await fsp.readdir(folderPath);
  } catch (e) {
    log.error(`Cannot read image folder ${folderPath}: ${e.message}`);
    return { valid: [], skipped: [] };
  }

  const valid   = [];
  const skipped = [];

  for (const f of files) {
    if (f.startsWith('.')) continue;
    const ext = path.extname(f).toLowerCase();
    if (VALID_IMAGE_EXTS.has(ext)) {
      valid.push(path.join(folderPath, f));
      log.zip(`  Found valid image: ${f}`);
    } else {
      skipped.push(`${f} (${ext || 'no extension'} not supported — use jpg/png/webp)`);
      log.warn(`  Skipped unsupported file: ${f} in ${folderPath}`);
    }
  }

  const limited = valid.slice(0, MAX_IMAGES);
  if (valid.length > MAX_IMAGES) {
    log.warn(`Folder ${path.basename(folderPath)} has ${valid.length} images, only first ${MAX_IMAGES} will be used.`);
  }

  return { valid: limited, skipped };
};

/** Safely remove a temp directory */
const rimraf = async (p) => {
  try { await fsp.rm(p, { recursive: true, force: true }); }
  catch (e) { log.error(`Failed to cleanup temp dir ${p}: ${e.message}`); }
};

// ═══════════════════════════════════════════════════════════════
// CONTROLLER 1 — previewCSV
// POST /admin/products/preview-csv
// multipart field: csvFile
// Returns preview data. Zero DB/Cloudinary writes.
// ═══════════════════════════════════════════════════════════════
const previewCSV = async (req, res) => {
  const filePath = req.file?.path;
  try {
    if (!filePath) {
      return res.status(400).json({ success: false, message: 'No file uploaded. Please attach a CSV or Excel file.' });
    }

    log.info(`Preview request — file: ${req.file.originalname}, size: ${req.file.size} bytes`);

    let rows;
    try {
      rows = parseSpreadsheet(filePath);
    } catch (e) {
      log.error(`Spreadsheet parse failed: ${e.message}`);
      return res.status(422).json({
        success: false,
        message: `Could not parse file: ${e.message}. Make sure it is a valid CSV or Excel file.`,
      });
    }

    log.info(`Parsed ${rows.length} rows from spreadsheet.`);

    if (!rows.length) {
      return res.status(422).json({ success: false, message: 'File appears to be empty.' });
    }

    // Check required columns
    const first    = rows[0];
    const required = ['name', 'category', 'baseprice'];
    const missing  = required.filter((c) => !(c in first));
    if (missing.length) {
      log.warn(`Missing required columns: ${missing.join(', ')}. Found columns: ${Object.keys(first).join(', ')}`);
      return res.status(422).json({
        success    : false,
        message    : `Missing required column(s): ${missing.join(', ')}. Your file has: ${Object.keys(first).join(', ')}`,
        missingCols: missing,
      });
    }

    const products     = groupRows(rows);
    const validCount   = products.filter((p) => validateProduct(p).length === 0).length;
    const invalidCount = products.length - validCount;
    const hasImageUrls = products.some((p) => p.variants.some((v) => v.imageUrls.length > 0));

    log.info(`Grouped into ${products.length} products. Valid: ${validCount}, Invalid: ${invalidCount}, Has image URLs: ${hasImageUrls}`);

    const preview = products.map((prod) => {
      const errors = validateProduct(prod);
      return {
        name         : prod.name,
        title        : prod.title,
        category     : prod.category,
        brand        : prod.brand,
        status       : prod.status,
        variantCount : prod.variants.length,
        barcodes     : prod.variants.map((v) => v.barcode).filter(Boolean),
        totalQuantity: prod.variants.reduce((s, v) => s + v.inventory.quantity, 0),
        imageUrlCount: prod.variants.reduce((s, v) => s + v.imageUrls.length, 0),
        priceRange: {
          min: Math.min(...prod.variants.map((v) => v.price.sale ?? v.price.base)),
          max: Math.max(...prod.variants.map((v) => v.price.base)),
        },
        errors,
        hasErrors: errors.length > 0,
      };
    });

    return res.status(200).json({
      success      : true,
      totalRows    : rows.length,
      totalProducts: products.length,
      validCount,
      invalidCount,
      hasImageUrls,
      preview,
      _parsedData  : products,
    });

  } catch (err) {
    log.error(`previewCSV fatal error: ${err.message}`, err.stack);
    return res.status(500).json({ success: false, message: 'Server error during preview.', error: err.message });
  } finally {
    if (filePath) fsp.unlink(filePath).catch(() => {});
  }
};

// ═══════════════════════════════════════════════════════════════
// CONTROLLER 2 — importProductsFromCSV
// POST /admin/products/import-csv
//
// multipart/form-data fields:
//   csvFile   — always required (spreadsheet with product data)
//   imageMode — 'url' | 'zip'
//   zipFile   — required when imageMode = 'zip'
//
// MODE A (imageMode=url):
//   Reads `images` column from Excel → downloads each URL → uploads to Cloudinary
//
// MODE B (imageMode=zip):
//   Extracts ZIP → finds barcode folders (flat OR wrapped) → uploads images to Cloudinary
//
// Per-product errors NEVER stop the whole batch.
// Full logging on every step.
// ═══════════════════════════════════════════════════════════════
const importProductsFromCSV = async (req, res) => {
  // multer .fields() puts files in req.files as { fieldname: [FileObject] }
  const csvFile   = req.files?.csvFile?.[0];
  const zipFile   = req.files?.zipFile?.[0];
  const imageMode = (req.body.imageMode || (zipFile ? 'zip' : 'url')).toLowerCase().trim();

  const csvPath    = csvFile?.path;
  const zipPath    = zipFile?.path;
  const extractDir = path.join(os.tmpdir(), `bulk_${Date.now()}`);

  log.info(`Import request — imageMode: ${imageMode}, csvFile: ${csvFile?.originalname || 'none'}, zipFile: ${zipFile?.originalname || 'none'}`);

  const report = {
    totalProducts : 0,
    savedProducts : 0,
    failedProducts: 0,
    products      : [],
  };

  try {
    // ── Validate inputs ────────────────────────────────────────
    if (!csvPath) {
      return res.status(400).json({ success: false, message: 'No spreadsheet uploaded. Attach a CSV or Excel file in the csvFile field.' });
    }
    if (imageMode === 'zip' && !zipPath) {
      log.warn('imageMode is "zip" but no ZIP file was attached. Will save products without images.');
    }

    // ── Parse spreadsheet ──────────────────────────────────────
    let rows;
    try {
      rows = parseSpreadsheet(csvPath);
    } catch (e) {
      log.error(`Spreadsheet parse failed: ${e.message}`);
      return res.status(422).json({ success: false, message: `Cannot parse spreadsheet: ${e.message}` });
    }

    log.info(`Parsed ${rows.length} rows.`);
    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Spreadsheet is empty.' });
    }

    const products = groupRows(rows);
    report.totalProducts = products.length;
    log.info(`Grouped into ${products.length} product(s).`);

    // ── Mode B: extract ZIP → build folder map ─────────────────
    let folderMap = new Map();
    let zipError  = null;

    if (imageMode === 'zip' && zipPath) {
      log.zip(`Extracting ZIP: ${zipFile.originalname} (${zipFile.size} bytes) → ${extractDir}`);
      try {
        await new Promise((resolve, reject) => {
          fs.createReadStream(zipPath)
            .pipe(unzipper.Extract({ path: extractDir }))
            .on('close', resolve)
            .on('error', reject);
        });
        log.zip('ZIP extraction complete.');
        folderMap = await buildFolderMap(extractDir);

        if (folderMap.size === 0) {
          zipError = 'ZIP was extracted but no barcode folders were found inside. Check your ZIP structure (see instructions).';
          log.warn(zipError);
        } else {
          log.zip(`Folder map built. ${folderMap.size} barcode(s) ready: [${[...folderMap.keys()].join(', ')}]`);
        }
      } catch (err) {
        zipError = `ZIP extraction failed: ${err.message}. Products will be saved without images.`;
        log.error(`ZIP extraction error: ${err.message}`, err.stack);
      }
    } else if (imageMode === 'zip' && !zipPath) {
      zipError = 'imageMode is "zip" but no ZIP file was provided. Products saved without images.';
      log.warn(zipError);
    }

    // ── Process each product ───────────────────────────────────
    for (const prod of products) {
      const pResult = {
        name      : prod.name,
        status    : 'pending',
        imageCount: 0,
        warnings  : [],
        errors    : [],
      };

      log.info(`Processing product: "${prod.name}" (${prod.variants.length} variant(s))`);

      try {
        // Server-side re-validation
        const errs = validateProduct(prod);
        if (errs.length) {
          log.warn(`"${prod.name}" validation failed: ${errs.join('; ')}`);
          pResult.status = 'failed';
          pResult.errors = errs;
          report.products.push(pResult);
          report.failedProducts++;
          continue;
        }

        // Find or create category
        const catSlug = slugify(prod.category, { lower: true, strict: true });
        let category  = await Category.findOne({ slug: catSlug });
        if (!category) {
          log.info(`Category "${prod.category}" not found — creating it.`);
          category = await Category.create({ name: prod.category, slug: catSlug, status: 'active', level: 0 });
        }

        // Build variants
        const processedVariants = [];

        for (const variant of prod.variants) {
          const warns  = [];
          const images = [];
          const normBC = normaliseKey(variant.barcode);

          log.info(`  Variant barcode: "${variant.barcode}" → normalised: "${normBC}"`);

          // ── MODE A: download from image URLs ──────────────────
          if (imageMode === 'url') {
            if (!variant.imageUrls.length) {
              const w = `Variant "${variant.barcode}": no image URLs in Excel — saved without images.`;
              warns.push(w);
              log.warn(`  ${w}`);
            } else {
              log.info(`  Uploading ${variant.imageUrls.length} image URL(s) for barcode "${variant.barcode}"…`);
              const results = await batchUpload(
                variant.imageUrls,
                (url, pid) => uploadUrlCld(url, pid),
                normBC || `nobc_${Date.now()}`
              );
              results.forEach((r, i) => {
                if (r.ok) {
                  images.push({ url: r.url, publicId: r.publicId, altText: `${prod.name} img ${i + 1}`, order: i });
                  pResult.imageCount++;
                } else {
                  const w = `Image ${i + 1} URL upload failed for "${variant.barcode}": ${r.error}`;
                  warns.push(w);
                  log.error(`  ${w}`);
                }
              });
            }
          }

          // ── MODE B: upload from ZIP barcode folder ────────────
          if (imageMode === 'zip') {
            if (!normBC) {
              const w = 'Variant has no barcode — cannot match to ZIP folder. Saved without images.';
              warns.push(w);
              log.warn(`  ${w}`);

            } else if (zipError && folderMap.size === 0) {
              // ZIP totally failed — don't spam per-variant, just note it
              warns.push(`ZIP issue: ${zipError}`);

            } else if (!folderMap.has(normBC)) {
              // Barcode not found — give admin ALL available keys to compare
              const available = [...folderMap.keys()];
              const sample    = available.slice(0, 10).join(', ');
              const w = `Barcode folder "${variant.barcode}" (normalised: "${normBC}") not found in ZIP. ` +
                        `Available barcode folders (${available.length}): [${sample}${available.length > 10 ? ', …' : ''}]. ` +
                        `Check for leading zeros, spaces, or wrong barcode in your Excel.`;
              warns.push(w);
              log.warn(`  MISMATCH — product: "${prod.name}", barcode in Excel: "${variant.barcode}", normalised: "${normBC}"`);
              log.warn(`  ZIP has ${available.length} folder(s): [${sample}]`);

            } else {
              // Found the folder — get images
              const folderPath = folderMap.get(normBC);
              log.zip(`  Barcode "${normBC}" matched → folder: ${folderPath}`);

              const { valid, skipped } = await getImages(folderPath);

              skipped.forEach((s) => {
                warns.push(`Skipped file in "${variant.barcode}" folder: ${s}`);
              });

              if (valid.length === 0 && skipped.length === 0) {
                const w = `Folder for barcode "${variant.barcode}" is empty — saved without images.`;
                warns.push(w);
                log.warn(`  ${w}`);
              } else if (valid.length === 0) {
                const w = `Folder for barcode "${variant.barcode}" has no supported image files (only unsupported formats found).`;
                warns.push(w);
                log.warn(`  ${w}`);
              } else {
                log.info(`  Uploading ${valid.length} image(s) for barcode "${variant.barcode}"…`);
                const results = await batchUpload(
                  valid,
                  (fp, pid) => uploadFileCld(fp, pid),
                  normBC
                );
                results.forEach((r, i) => {
                  if (r.ok) {
                    images.push({ url: r.url, publicId: r.publicId, altText: `${prod.name} img ${i + 1}`, order: i });
                    pResult.imageCount++;
                  } else {
                    const w = `Image ${i + 1} Cloudinary upload failed for barcode "${variant.barcode}": ${r.error}`;
                    warns.push(w);
                    log.error(`  ${w}`);
                  }
                });
              }
            }
          }

          // Collect warnings
          pResult.warnings.push(...warns);

          // Build variant for DB
          const sku = await generateSku();
          processedVariants.push({
            sku,
            barcode   : variant.barcode ? (Number(variant.barcode) || variant.barcode) : undefined,
            attributes: variant.variantAttributes,
            price     : variant.price,
            inventory : variant.inventory,
            images,
            isActive  : variant.isActive,
          });
        }

        // Calculate price range and stock
        const prices     = processedVariants.map((v) => v.price.sale != null ? v.price.sale : v.price.base);
        const totalStock = processedVariants.reduce((s, v) => s + (v.inventory.quantity || 0), 0);
        const slug       = await generateSlug(prod.name);

        await new Product({
          name       : prod.name,
          slug,
          title      : prod.title,
          description: prod.description,
          category   : category._id,
          brand      : prod.brand,
          variants   : processedVariants,
          priceRange : { min: Math.min(...prices), max: Math.max(...prices) },
          totalStock,
          soldInfo   : prod.soldInfo,
          fomo       : prod.fomo,
          shipping   : prod.shipping,
          attributes : prod.productAttributes,
          isFeatured : prod.isFeatured,
          status     : prod.status,
        }).save();

        pResult.status = pResult.warnings.length ? 'saved_with_warnings' : 'success';
        report.savedProducts++;
        log.info(`✓ Saved "${prod.name}" — images: ${pResult.imageCount}, warnings: ${pResult.warnings.length}`);

      } catch (e) {
        pResult.status = 'failed';
        pResult.errors.push(e.message);
        report.failedProducts++;
        log.error(`Product "${prod.name}" failed fatally: ${e.message}`, e.stack);
      }

      report.products.push(pResult);
    }

    log.info(`Import complete. Saved: ${report.savedProducts}, Failed: ${report.failedProducts}, Total: ${report.totalProducts}`);

    return res.status(201).json({
      success         : true,
      message         : 'Bulk import complete.',
      imageMode,
      totalRows       : report.totalProducts,
      insertedProducts: report.savedProducts,
      failedCount     : report.failedProducts,
      zipError        : zipError || undefined,
      products        : report.products,
    });

  } catch (err) {
    log.error(`importProductsFromCSV FATAL: ${err.message}`, err.stack);
    return res.status(500).json({ success: false, message: 'Bulk import failed.', error: err.message });
  } finally {
    if (csvPath) fsp.unlink(csvPath).catch(() => {});
    if (zipPath) fsp.unlink(zipPath).catch(() => {});
    await rimraf(extractDir);
  }
};

// ═══════════════════════════════════════════════════════════════
// ALL OTHER CONTROLLERS — UNCHANGED FROM YOUR ORIGINAL
// ═══════════════════════════════════════════════════════════════

const createProduct = async (req, res) => {
  try {
    const { name, title, description, category, brand, status, isFeatured, soldInfo, fomo, shipping, attributes, variants: variantsRaw } = req.body;
    if (!name || !title || !category) return res.status(400).json({ success: false, message: "Name, title and category are required" });
    if (!mongoose.Types.ObjectId.isValid(category)) return res.status(400).json({ success: false, message: "Invalid category ID format" });
    const existingCategory = await Category.findById(category);
    if (!existingCategory) return res.status(400).json({ success: false, message: "Selected category does not exist." });
    let variantsInput = variantsRaw;
    if (typeof variantsRaw === "string") variantsInput = JSON.parse(variantsRaw);
    const slug = await generateSlug(name);
    const variants = [];
    const filesByVariant = {};
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const match = file.fieldname.match(/^variantImages_(\d+)$/);
        if (match) { const idx = Number(match[1]); if (!filesByVariant[idx]) filesByVariant[idx] = []; filesByVariant[idx].push(file); }
      }
    }
    for (const idxStr of Object.keys(filesByVariant)) {
      if (filesByVariant[Number(idxStr)].length > 5) return res.status(400).json({ success: false, message: `Variant ${idxStr} can have at most 5 images` });
    }
    for (let i = 0; i < variantsInput.length; i++) {
      const v = variantsInput[i];
      if (!v.barcode) return res.status(400).json({ success: false, message: `Barcode is required for variant ${i}` });
      const barcodeNumber = Number(v.barcode);
      if (isNaN(barcodeNumber)) return res.status(400).json({ success: false, message: `Barcode must be a valid number for variant ${i}` });
      const existingBarcode = await Product.findOne({ "variants.barcode": barcodeNumber });
      if (existingBarcode) return res.status(400).json({ success: false, message: `Barcode ${barcodeNumber} already exists` });
      const skuVal = await generateSku();
      const priceObj = { base: Number(v.price?.base) || 0, sale: v.price?.sale != null ? Number(v.price.sale) : null };
      if (priceObj.sale != null && priceObj.sale >= priceObj.base) return res.status(400).json({ success: false, message: `Sale price must be less than base price for variant ${i}` });
      const inventoryObj = { quantity: Number(v.inventory?.quantity) || 0, trackInventory: v.inventory?.trackInventory !== false, lowStockThreshold: v.inventory?.lowStockThreshold || 5 };
      const variantImages = [];
      if (filesByVariant[i]) {
        for (let imgIdx = 0; imgIdx < filesByVariant[i].length; imgIdx++) {
          const file = filesByVariant[i][imgIdx];
          const buf = await sharp(file.buffer).resize({ width: 1500, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
          const { url, publicId } = await uploadToCloudinary(buf, `products/${slug}`, `${slug}_${skuVal}_img${imgIdx + 1}_${Date.now()}`);
          variantImages.push({ url, publicId, altText: `${name} ${skuVal} image ${imgIdx + 1}`, order: imgIdx });
        }
      }
      variants.push({ sku: skuVal, barcode: barcodeNumber, attributes: Array.isArray(v.attributes) ? v.attributes.map(a => ({ key: a.key, value: a.value })) : [], price: priceObj, inventory: inventoryObj, images: variantImages, isActive: v.isActive !== false });
    }
    const ep = variants.map(v => v.price.sale != null ? v.price.sale : v.price.base);
    let parsedSoldInfo = soldInfo, parsedFomo = fomo, parsedShipping = shipping, parsedAttributes = attributes;
    try {
      if (typeof soldInfo === "string") parsedSoldInfo = JSON.parse(soldInfo);
      if (typeof fomo === "string") parsedFomo = JSON.parse(fomo);
      if (typeof shipping === "string") parsedShipping = JSON.parse(shipping);
      if (typeof attributes === "string") parsedAttributes = JSON.parse(attributes);
    } catch { return res.status(400).json({ success: false, message: "Invalid JSON in request body" }); }
    const product = new Product({ name, slug, title, description: description || "", category: existingCategory._id, brand: brand || "Generic", variants, priceRange: { min: Math.min(...ep), max: Math.max(...ep) }, totalStock: variants.reduce((s, v) => s + (v.inventory.quantity || 0), 0), isFeatured: isFeatured || false, soldInfo: parsedSoldInfo || { enabled: false, count: 0 }, fomo: parsedFomo || { enabled: false, type: "viewing_now", viewingNow: 0 }, shipping: parsedShipping || { weight: 0, dimensions: { length: 0, width: 0, height: 0 } }, attributes: parsedAttributes || [], status: status || "draft" });
    await product.save();
    return res.status(201).json({ success: true, message: "Product created successfully", product, categoryDetails: existingCategory.name });
  } catch (error) { console.error("Create product error:", error); return res.status(500).json({ success: false, message: "Error creating product", error: error.message }); }
};

const bulkCreateProducts = async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || !products.length) return res.status(400).json({ success: false, message: "products array is required" });
    const created = [], failed = [];
    for (const item of products) {
      try {
        if (!item.name || !item.title || !item.category) throw new Error("Missing required fields");
        const slug = await generateSlug(item.name);
        const p = (v) => { if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } } return v; };
        const si = p(item.soldInfo) || {}, fi = p(item.fomo) || {}, shi = p(item.shipping) || {}, ai = p(item.attributes) || [], vi = p(item.variants);
        let variants = [];
        if (Array.isArray(vi) && vi.length) {
          variants = vi.map((v, idx) => { const bp = Number(v.price?.base || 0), sp = v.price?.sale != null ? Number(v.price.sale) : null; if (sp && sp >= bp) throw new Error("Invalid sale price"); return { sku: v.sku ? String(v.sku).toUpperCase() : `${slug}-VAR${idx + 1}`.toUpperCase(), attributes: Array.isArray(v.attributes) ? v.attributes.map(a => ({ key: a.key, value: a.value })) : [], price: { base: bp, sale: sp }, inventory: { quantity: Number(v.inventory?.quantity ?? 0), trackInventory: v.inventory?.trackInventory ?? true, lowStockThreshold: Number(v.inventory?.lowStockThreshold ?? 5) }, images: [], isActive: v.isActive ?? true }; });
        } else { const bp = Number(item.price?.base || item.price || 0); variants.push({ sku: `${slug}-VAR1`.toUpperCase(), attributes: [], price: { base: bp, sale: null }, inventory: { quantity: Number(item.inventory?.quantity ?? 0), trackInventory: item.inventory?.trackInventory ?? true, lowStockThreshold: Number(item.inventory?.lowStockThreshold ?? 5) }, images: [], isActive: true }); }
        const ep = variants.map(v => v.price.sale != null ? v.price.sale : v.price.base);
        const prod = new Product({ name: item.name, slug, title: item.title, description: item.description || "", category: item.category, brand: item.brand || "Generic", variants, priceRange: { min: Math.min(...ep), max: Math.max(...ep) }, totalStock: variants.reduce((s, v) => s + (v.inventory.quantity || 0), 0), soldInfo: { enabled: si.enabled ?? false, count: Number(si.count ?? 0) }, fomo: { enabled: fi.enabled ?? false, type: fi.type || "viewing_now", viewingNow: Number(fi.viewingNow ?? 0), productLeft: Number(fi.productLeft ?? 0), customMessage: fi.customMessage || "" }, shipping: { weight: Number(shi.weight ?? 0), dimensions: { length: Number(shi.dimensions?.length ?? 0), width: Number(shi.dimensions?.width ?? 0), height: Number(shi.dimensions?.height ?? 0) } }, attributes: Array.isArray(ai) ? ai.map(a => ({ key: a.key, value: a.value })) : [], isFeatured: item.isFeatured ?? false, status: item.status || "draft" });
        await prod.save(); created.push(prod);
      } catch (err) { failed.push({ name: item.name || "Unknown", error: err.message }); }
    }
    return res.status(201).json({ success: true, message: "Bulk create complete", totalRequested: products.length, createdCount: created.length, failedCount: failed.length, failedProducts: failed });
  } catch (error) { return res.status(500).json({ success: false, message: "Error creating products", error: error.message }); }
};

const updateProduct = async (req, res) => {
  try {
    const slug = req.params.slug;
    const existingProduct = await Product.findOne({ slug });
    if (!existingProduct) return res.status(404).json({ success: false, message: "Product not found" });
    const updates = { ...req.body };
    delete updates.slug; delete updates.sku; delete updates.variants;
    const pis = (value, fallback) => { if (typeof value === "string") { try { return JSON.parse(value); } catch { return fallback; } } return value; };
    if (updates.barcode) {
      const bn = Number(updates.barcode);
      if (isNaN(bn)) return res.status(400).json({ success: false, message: "Invalid barcode" });
      const vi = existingProduct.variants.findIndex(v => v.barcode === bn);
      if (vi === -1) return res.status(404).json({ success: false, message: "No product found with this barcode" });
      const ev = existingProduct.variants[vi];
      const uf = {};
      if (updates.price) { const pp = pis(updates.price, {}); const base = pp.base !== undefined ? Number(pp.base) : ev.price.base; const sale = pp.sale !== undefined ? (pp.sale != null ? Number(pp.sale) : null) : ev.price.sale; if (sale != null && sale >= base) return res.status(400).json({ success: false, message: "Sale price must be less than base price" }); if (pp.base !== undefined) uf["variants.$.price.base"] = base; if (pp.sale !== undefined) uf["variants.$.price.sale"] = sale; }
      if (updates.inventory) { const pi = pis(updates.inventory, {}); if (pi.quantity !== undefined) uf["variants.$.inventory.quantity"] = Number(pi.quantity); if (pi.lowStockThreshold !== undefined) uf["variants.$.inventory.lowStockThreshold"] = Number(pi.lowStockThreshold); if (pi.trackInventory !== undefined) uf["variants.$.inventory.trackInventory"] = pi.trackInventory; }
      const hasNewFiles = req.files && req.files.length > 0;
      const eir = updates.existingImages;
      if (hasNewFiles) { if (ev.images?.length) for (const img of ev.images) { if (img.publicId) await deleteFromCloudinary(img.publicId); } const ui = []; for (let i = 0; i < req.files.length; i++) { const file = req.files[i]; if (!file.buffer) continue; const r = await uploadToCloudinary(file.buffer, "products"); ui.push({ url: r.url, publicId: r.publicId, altText: existingProduct.name, order: i }); } uf["variants.$.images"] = ui; } else if (eir) { try { const ro = pis(eir, null); if (Array.isArray(ro) && ro.length) uf["variants.$.images"] = ro.map((img, i) => ({ url: img.url || "", publicId: img.publicId || "", altText: img.altText || existingProduct.name, order: i })); } catch (e) { console.warn("existingImages parse error:", e.message); } }
      if (updates.isActive !== undefined) uf["variants.$.isActive"] = updates.isActive === true || updates.isActive === "true";
      if (updates.attributes) { const pa = pis(updates.attributes, []); if (Array.isArray(pa)) uf["variants.$.attributes"] = pa.map(a => ({ key: a.key, value: a.value })); }
      const up = await Product.findOneAndUpdate({ slug, "variants.barcode": bn }, { $set: uf }, { new: true });
      const ep = up.variants.map(v => v.price.sale != null ? v.price.sale : v.price.base);
      up.priceRange = { min: Math.min(...ep), max: Math.max(...ep) };
      up.totalStock = up.variants.reduce((s, v) => s + (v.inventory.quantity || 0), 0);
      await up.save();
      return res.status(200).json({ success: true, message: "Variant updated successfully", product: up });
    }
    if (updates.name && updates.name !== existingProduct.name) updates.slug = await generateSlug(updates.name, existingProduct._id);
    if (updates.soldInfo) { const p = pis(updates.soldInfo, {}); updates.soldInfo = { ...existingProduct.soldInfo.toObject(), ...p, enabled: p.enabled === true || p.enabled === "true", count: Number(p.count ?? 0) }; }
    if (updates.fomo) { const p = pis(updates.fomo, {}); updates.fomo = { ...existingProduct.fomo.toObject(), ...p, enabled: p.enabled === true || p.enabled === "true", viewingNow: Number(p.viewingNow ?? 0), productLeft: Number(p.productLeft ?? 0), type: ["viewing_now", "product_left", "custom"].includes(p.type) ? p.type : existingProduct.fomo.type }; }
    if (updates.shipping) { const p = pis(updates.shipping, {}); updates.shipping = { ...existingProduct.shipping.toObject(), ...p, weight: Number(p.weight ?? 0), dimensions: { length: Number(p.dimensions?.length ?? 0), width: Number(p.dimensions?.width ?? 0), height: Number(p.dimensions?.height ?? 0) } }; }
    if (updates.attributes) { const p = pis(updates.attributes, []); updates.attributes = Array.isArray(p) ? p.map(a => ({ key: a.key, value: a.value })) : []; }
    const up = await Product.findByIdAndUpdate(existingProduct._id, { $set: updates }, { new: true, runValidators: true });
    return res.status(200).json({ success: true, message: "Product updated successfully", product: up });
  } catch (error) { console.error("Update product error:", error); return res.status(500).json({ success: false, message: "Error updating product", error: error.message }); }
};

const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findOneAndUpdate({ slug: req.params.slug, status: { $ne: "archived" } }, { $set: { status: "archived" } }, { new: true });
    if (!product) return res.status(404).json({ success: false, message: "Product not found or already archived" });
    return res.status(200).json({ success: true, message: "Product archived successfully", product });
  } catch (error) { return res.status(500).json({ success: false, message: "Error archiving product", error: error.message }); }
};

const bulkDelete = async (req, res) => {
  try {
    let { slugs } = req.body;
    if (!Array.isArray(slugs) || !slugs.length) return res.status(400).json({ success: false, message: "slugs array is required" });
    slugs = slugs.filter(s => typeof s === "string" && s.trim()).map(s => s.trim());
    if (!slugs.length) return res.status(400).json({ success: false, message: "No valid slugs" });
    if (slugs.length > 500) return res.status(400).json({ success: false, message: "Max 500 per request" });
    const r = await Product.updateMany({ slug: { $in: slugs }, status: { $ne: "archived" } }, { $set: { status: "archived", archivedAt: new Date() } });
    return res.status(200).json({ success: true, message: "Bulk archive complete", requested: slugs.length, archived: r.modifiedCount, skipped: slugs.length - r.modifiedCount });
  } catch (error) { return res.status(500).json({ success: false, message: "Error archiving products", error: error.message }); }
};

const restoreProduct = async (req, res) => {
  try {
    const product = await Product.findOneAndUpdate({ slug: req.params.slug, status: "archived" }, { $set: { status: "active" }, $unset: { archivedAt: "" } }, { new: true });
    if (!product) return res.status(404).json({ success: false, message: "Archived product not found" });
    return res.status(200).json({ success: true, message: "Product restored successfully", product });
  } catch (error) { return res.status(500).json({ success: false, message: "Error restoring product", error: error.message }); }
};

const bulkRestore = async (req, res) => {
  try {
    let { slugs } = req.body;
    if (!Array.isArray(slugs) || !slugs.length) return res.status(400).json({ success: false, message: "slugs array is required" });
    slugs = slugs.filter(s => typeof s === "string" && s.trim()).map(s => s.trim());
    if (!slugs.length) return res.status(400).json({ success: false, message: "No valid slugs" });
    if (slugs.length > 500) return res.status(400).json({ success: false, message: "Max 500 per request" });
    const r = await Product.updateMany({ slug: { $in: slugs }, status: "archived" }, { $set: { status: "active" }, $unset: { archivedAt: "" } });
    return res.status(200).json({ success: true, message: "Bulk restore complete", requested: slugs.length, restored: r.modifiedCount, skipped: slugs.length - r.modifiedCount });
  } catch (error) { return res.status(500).json({ success: false, message: "Error restoring products", error: error.message }); }
};

const getLowStockProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;
    const pn = Math.max(1, Number(page)), ln = Math.min(100, Number(limit)), skip = (pn - 1) * ln;
    const q = { status: "active", $expr: { $anyElementTrue: { $map: { input: "$variants", as: "v", in: { $and: [{ $eq: ["$$v.inventory.trackInventory", true] }, { $gt: ["$$v.inventory.quantity", 0] }, { $lte: ["$$v.inventory.quantity", "$$v.inventory.lowStockThreshold"] }] } } } } };
    const [products, total] = await Promise.all([Product.find(q).sort({ "variants.inventory.quantity": 1 }).skip(skip).limit(ln), Product.countDocuments(q)]);
    return res.status(200).json({ success: true, total, page: pn, limit: ln, count: products.length, products });
  } catch (error) { return res.status(500).json({ success: false, message: "Error fetching low stock products", error: error.message }); }
};

const getAllActiveProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;
    const pn = Math.max(1, Number(page)), ln = Math.min(100, Number(limit)), skip = (pn - 1) * ln;
    const [products, total] = await Promise.all([Product.find({ status: "active" }).populate("category", "name").sort({ createdAt: -1 }).skip(skip).limit(ln).lean(), Product.countDocuments({ status: "active" })]);
    return res.status(200).json({ success: true, total, page: pn, limit: ln, count: products.length, products });
  } catch (error) { return res.status(500).json({ success: false, message: "Error fetching products", error: error.message }); }
};

const getProductBySlug = async (req, res) => {
  try {
    const slug = req.params.slug?.trim();
    if (!slug) return res.status(400).json({ success: false, message: "Invalid product slug" });
    const product = await Product.findOne({ slug, status: "active" }).populate("category", "name").lean();
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    return res.status(200).json({ success: true, product });
  } catch (error) { return res.status(500).json({ success: false, message: "Error fetching product", error: error.message }); }
};

const getArchivedProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;
    const pn = Math.max(1, Number(page)), ln = Math.min(100, Number(limit)), skip = (pn - 1) * ln;
    const [products, total] = await Promise.all([Product.find({ status: "archived" }).populate("category", "name").sort({ createdAt: -1 }).skip(skip).limit(ln).lean(), Product.countDocuments({ status: "archived" })]);
    return res.status(200).json({ success: true, total, page: pn, limit: ln, count: products.length, products });
  } catch (error) { return res.status(500).json({ success: false, message: "Error fetching archived products", error: error.message }); }
};

const getDraftProducts = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;
    const pn = Math.max(1, Number(page)), ln = Math.min(100, Number(limit)), skip = (pn - 1) * ln;
    const [products, total] = await Promise.all([Product.find({ status: "draft" }).populate("category", "name").sort({ createdAt: -1 }).skip(skip).limit(ln).lean(), Product.countDocuments({ status: "draft" })]);
    return res.status(200).json({ success: true, total, page: pn, limit: ln, count: products.length, products });
  } catch (error) { return res.status(500).json({ success: false, message: "Error fetching draft products", error: error.message }); }
};

const hardDeleteProduct = async (req, res) => {
  try {
    const { slug } = req.params;
    if (!slug) return res.status(400).json({ success: false, message: "Invalid product slug" });
    const product = await Product.findOne({ slug }).lean();
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    if (product.status !== "archived") return res.status(400).json({ success: false, message: "Only archived products can be permanently deleted" });
    const pids = [];
    if (Array.isArray(product.images)) product.images.forEach(img => { if (img.publicId) pids.push(img.publicId); });
    if (Array.isArray(product.variants)) product.variants.forEach(v => { if (Array.isArray(v.images)) v.images.forEach(img => { if (img.publicId) pids.push(img.publicId); }); });
    await Promise.all([...new Set(pids)].map(id => deleteFromCloudinary(id).catch(() => {})));
    await Product.deleteOne({ _id: product._id });
    return res.status(200).json({ success: true, message: "Product permanently deleted" });
  } catch (error) { return res.status(500).json({ success: false, message: "Error permanently deleting product", error: error.message }); }
};

const bulkHardDelete = async (req, res) => {
  try {
    const { slugs } = req.body;
    if (!Array.isArray(slugs) || !slugs.length) return res.status(400).json({ success: false, message: "slugs array is required" });
    const products = await Product.find({ slug: { $in: slugs }, status: "archived" }).lean();
    if (!products.length) return res.status(404).json({ success: false, message: "No archived products found" });
    const pids = [];
    for (const p of products) {
      if (Array.isArray(p.images)) p.images.forEach(img => { if (img.publicId) pids.push(img.publicId); });
      if (Array.isArray(p.variants)) p.variants.forEach(v => { if (Array.isArray(v.images)) v.images.forEach(img => { if (img.publicId) pids.push(img.publicId); }); });
    }
    if (pids.length) await Promise.allSettled(pids.map(id => deleteFromCloudinary(id)));
    const r = await Product.deleteMany({ _id: { $in: products.map(p => p._id) } });
    return res.status(200).json({ success: true, message: "Products permanently deleted", requested: slugs.length, deletedCount: r.deletedCount, skipped: slugs.length - r.deletedCount });
  } catch (error) { return res.status(500).json({ success: false, message: "Error permanently deleting products", error: error.message }); }
};

const getAllProductsAdmin = async (req, res) => {
  try {
    let { page = 1, limit = 20 } = req.query;
    page = Number(page); limit = Math.min(100, Math.max(1, Number(limit)));
    const products = await Product.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
    const total = await Product.countDocuments();
    return res.status(200).json({ success: true, totalProducts: total, totalPages: Math.ceil(total / limit), currentPage: page, products });
  } catch (error) { return res.status(500).json({ success: false, message: "Error fetching products", error: error.message }); }
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

// const getAdminProducts = async (req, res) => {
//   try {
//     const products = await Product.find();
//     return res.status(200).json({ success: true, products });
//   } catch (error) { return res.status(500).json({ success: false, message: "Error fetching admin products", error: error.message }); }
// };

const addVariant = async (req, res) => {
  try {
    const { slug } = req.params;
    const product = await Product.findOne({ slug });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    let variant = { ...req.body };
    const pis = (v, fb) => { if (typeof v === "string") { try { return JSON.parse(v); } catch { return fb; } } return v; };
    if (variant.price) variant.price = pis(variant.price, {});
    if (variant.attributes) variant.attributes = pis(variant.attributes, []);
    if (variant.inventory) variant.inventory = pis(variant.inventory, {});
    if (!variant.barcode) return res.status(400).json({ success: false, message: "Barcode is required" });
    const bn = Number(variant.barcode);
    if (isNaN(bn)) return res.status(400).json({ success: false, message: "Barcode must be a valid number" });
    if (await Product.exists({ "variants.barcode": bn })) return res.status(400).json({ success: false, message: "Variant with this barcode already exists" });
    if (!variant.price?.base) return res.status(400).json({ success: false, message: "Base price is required" });
    const bp = Number(variant.price.base);
    if (isNaN(bp) || bp <= 0) return res.status(400).json({ success: false, message: "Base price must be > 0" });
    const sp = variant.price.sale != null ? Number(variant.price.sale) : null;
    if (sp !== null && (isNaN(sp) || sp >= bp)) return res.status(400).json({ success: false, message: "Sale price must be less than base price" });
    const sku = await generateSku();
    const images = [];
    if (req.files?.length) {
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i]; if (!file.buffer) continue;
        const r = await uploadToCloudinary(file.buffer, "products");
        images.push({ url: r.url, publicId: r.publicId, altText: product.name, order: i });
      }
    }
    product.variants.push({ sku, barcode: bn, attributes: Array.isArray(variant.attributes) ? variant.attributes.filter(a => a.key && a.value).map(a => ({ key: a.key, value: a.value })) : [], price: { base: bp, sale: sp }, inventory: { quantity: Number(variant.inventory?.quantity || 0), lowStockThreshold: Number(variant.inventory?.lowStockThreshold || 5), trackInventory: variant.inventory?.trackInventory !== false }, images, isActive: variant.isActive !== false });
    const ep = product.variants.map(v => v.price.sale != null ? v.price.sale : v.price.base);
    product.priceRange = { min: Math.min(...ep), max: Math.max(...ep) };
    product.totalStock = product.variants.reduce((s, v) => s + (v.inventory.quantity || 0), 0);
    await product.save();
    return res.status(200).json({ success: true, message: "Variant added successfully", product });
  } catch (error) { return res.status(500).json({ success: false, message: "Error adding variant", error: error.message }); }
};

const deleteVariant = async (req, res) => {
  try {
    const { slug } = req.params; const { barcode } = req.body;
    if (!barcode) return res.status(400).json({ success: false, message: "Barcode is required" });
    const bn = Number(barcode);
    if (isNaN(bn)) return res.status(400).json({ success: false, message: "Invalid barcode" });
    const product = await Product.findOne({ slug });
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });
    if (!product.variants.some(v => v.barcode === bn)) return res.status(404).json({ success: false, message: "Variant not found" });
    if (product.variants.length === 1) return res.status(400).json({ success: false, message: "Cannot delete last variant" });
    product.variants = product.variants.filter(v => v.barcode !== bn);
    const ep = product.variants.map(v => v.price.sale != null ? v.price.sale : v.price.base);
    product.priceRange = { min: Math.min(...ep), max: Math.max(...ep) };
    product.totalStock = product.variants.reduce((s, v) => s + (v.inventory.quantity || 0), 0);
    await product.save();
    return res.status(200).json({ success: true, message: "Variant deleted successfully", product });
  } catch (error) { return res.status(500).json({ success: false, message: "Error deleting variant", error: error.message }); }
};

const getVariantByBarcode = async (req, res) => {
  try {
    const bn = Number(req.params.barcode);
    if (isNaN(bn)) return res.status(400).json({ success: false, message: "Invalid barcode" });
    const product = await Product.findOne({ "variants.barcode": bn }, { name: 1, slug: 1, brand: 1, category: 1, fomo: 1, soldInfo: 1, "variants.$": 1 });
    if (!product) return res.status(404).json({ success: false, message: "No product found for this barcode" });
    return res.status(200).json({ success: true, product: { _id: product._id, name: product.name, slug: product.slug, brand: product.brand, category: product.category, fomo: product.fomo, soldInfo: product.soldInfo }, variant: product.variants[0] });
  } catch (error) { return res.status(500).json({ success: false, message: "Error fetching variant", error: error.message }); }
};

module.exports = {
  createProduct, updateProduct, deleteProduct, bulkDelete,
  hardDeleteProduct, bulkHardDelete, restoreProduct, bulkRestore,
  getLowStockProducts, getAllActiveProducts, getArchivedProducts,
  getDraftProducts, getProductBySlug, bulkCreateProducts,
  addVariant, deleteVariant, getVariantByBarcode,
  previewCSV,
  importProductsFromCSV,
  getAllProductsAdmin, 
  bulkUploadNewProductsWithImages
  // getAdminProducts,
};

// karan changes images upload in zip format >>>>>>>>>>>>>>>>>>>>>>
// const { cloudinary, initCloudinary } = require('../config/cloudinary.config');
// const Product  = require('../models/Product');
// const Category = require('../models/Category');
// const mongoose = require('mongoose');
// const slugify  = require('slugify');
// const { generateSlug, generateSku } = require('../utils/productUtils');
// const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinaryHelper');
// const sharp    = require('sharp');
// const fs                  = require('fs');
// const { promises: fsp }   = require('fs');
// const csv      = require('csv-parser');
// const unzipper = require('unzipper');
// const path     = require('path');
// const axios    = require('axios');
// const os       = require('os');
// const xlsx     = require('xlsx'); // npm install xlsx

// // ─────────────────────────────────────────────────────────────
// // BULK UPLOAD CONSTANTS
// // ─────────────────────────────────────────────────────────────
// const MAX_IMAGES_PER_VARIANT = 5;
// const CLOUDINARY_BATCH_SIZE  = 5;
// const CLOUDINARY_RETRY_MAX   = 2;
// const SUPPORTED_IMAGE_EXTS   = ['.jpg', '.jpeg', '.png', '.webp'];
// const SKIP_FOLDERS           = ['__macosx', '.ds_store', 'thumbs.db'];

// // ─────────────────────────────────────────────────────────────
// // HELPERS
// // ─────────────────────────────────────────────────────────────

// // Normalise barcode — handles: BOM, encoding garbage (cafÃ©), trim,
// // lowercase, leading zeros preserved as string
// const normaliseBarcode = (raw) => {
//   if (raw === null || raw === undefined) return '';
//   return String(raw)
//     .replace(/^\uFEFF/, '')        // strip BOM
//     .replace(/[^\x20-\x7E]/g, '') // strip non-ASCII (encoding disasters)
//     .trim()
//     .toLowerCase();
// };

// // Strip Excel BOM from header strings
// const stripBOM = (str) => String(str || '').replace(/^\uFEFF/, '');

// // Parse spreadsheet (CSV, XLS, XLSX) → plain row objects
// // All header keys lowercased + trimmed so "basePrice" === "baseprice" === "BasePrice"
// const parseSpreadsheet = (filePath) => {
//   const wb   = xlsx.readFile(filePath, { raw: false, defval: '' });
//   const ws   = wb.Sheets[wb.SheetNames[0]];
//   const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });

//   return rows.map(row => {
//     const clean = {};
//     for (const [k, v] of Object.entries(row)) {
//       const key    = stripBOM(k).trim().toLowerCase();
//       clean[key]   = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
//     }
//     return clean;
//   });
// };

// // Parse "Color:Black|Size:L" → [{key,value}]
// const parseAttributes = (raw) => {
//   if (!raw || !String(raw).trim()) return [];
//   return String(raw).split('|').map(pair => {
//     const [key, ...rest] = pair.split(':');
//     return { key: (key || '').trim(), value: rest.join(':').trim() };
//   }).filter(a => a.key && a.value);
// };

// // Group CSV rows → products (multi-row = multi-variant)
// const groupRowsIntoProducts = (rows) => {
//   const map   = new Map();
//   const order = [];

//   rows.forEach((row, idx) => {
//     const name = (row.name || '').trim();
//     if (!name) return;

//     // Preserve barcode as string — leading zeros must survive
//     const barcode = String(row.barcode || '').trim();

//     const variant = {
//       barcode,
//       variantAttributes : parseAttributes(row.variantattributes || row.variantAttributes || ''),
//       price: {
//         base: Number((row.baseprice  || row.basePrice  || '0').replace(/[^0-9.]/g, '') || 0),
//         sale: (row.saleprice || row.salePrice)
//           ? Number((row.saleprice || row.salePrice).replace(/[^0-9.]/g, '') || 0)
//           : null,
//       },
//       inventory: {
//         quantity          : Number(row.quantity || 0),
//         trackInventory    : String(row.trackinventory || 'true').toLowerCase() !== 'false',
//         lowStockThreshold : Number(row.lowstockthreshold || 5),
//       },
//       images   : [],
//       isActive : String(row.isactive || 'true').toLowerCase() !== 'false',
//       _rowIndex: idx + 2, // 1-based + header row — used in error messages
//     };

//     if (!map.has(name)) {
//       order.push(name);
//       map.set(name, {
//         name,
//         title             : (row.title || name).trim(),
//         description       : (row.description || '').trim(),
//         category          : (row.category || '').trim(),
//         brand             : (row.brand || 'Generic').trim(),
//         status            : (row.status || 'draft').toLowerCase().trim(),
//         isFeatured        : String(row.isfeatured || 'false').toLowerCase() === 'true',
//         productAttributes : parseAttributes(row.productattributes || row.productAttributes || ''),
//         soldInfo: {
//           enabled: String(row.soldenabled || row.soldEnabled || 'false').toLowerCase() === 'true',
//           count  : Number(row.soldcount   || row.soldCount   || 0),
//         },
//         fomo: {
//           enabled      : String(row.fomoenabled || row.fomoEnabled || 'false').toLowerCase() === 'true',
//           type         : (row.fomotype || row.fomoType || 'viewing_now').trim(),
//           viewingNow   : Number(row.viewingnow   || row.viewingNow   || 0),
//           productLeft  : Number(row.productleft  || row.productLeft  || 0),
//           customMessage: (row.custommessage || row.customMessage || '').trim(),
//         },
//         shipping: {
//           weight    : Number(row.weight || 0),
//           dimensions: {
//             length: Number(row.length || 0),
//             width : Number(row.width  || 0),
//             height: Number(row.height || 0),
//           },
//         },
//         variants: [],
//       });
//     }

//     map.get(name).variants.push(variant);
//   });

//   return order.map(n => map.get(n));
// };

// // Validate a single product — returns [] if clean
// const validateProduct = (prod) => {
//   const errs = [];
//   if (!prod.name)     errs.push('name is required');
//   if (!prod.category) errs.push('category is required');
//   prod.variants.forEach((v, i) => {
//     if (!v.price.base || v.price.base <= 0)
//       errs.push(`variant ${i + 1} (row ${v._rowIndex}): basePrice must be > 0`);
//     if (v.price.sale !== null && v.price.sale >= v.price.base)
//       errs.push(`variant ${i + 1} (row ${v._rowIndex}): salePrice must be less than basePrice`);
//   });
//   return errs;
// };

// // Upload one image to Cloudinary with retry + exponential backoff
// // uploadToCloudinary expects: (buffer, folder, publicId)
// const uploadImageWithRetry = async (imgPath, publicId, attempt = 1) => {
//   try {
//     // Read file into buffer — helper expects buffer, not file path
//     const buffer = await fsp.readFile(imgPath);
//     const { url, publicId: pubId } = await uploadToCloudinary(buffer, 'products/bulk', publicId);
//     return { success: true, url, publicId: pubId };
//   } catch (err) {
//     if (attempt < CLOUDINARY_RETRY_MAX) {
//       await new Promise(r => setTimeout(r, 1000 * attempt));
//       return uploadImageWithRetry(imgPath, publicId, attempt + 1);
//     }
//     return { success: false, error: err.message, attempts: attempt };
//   }
// };

// // Upload images in parallel batches — never sequential, never blows rate limit
// const uploadImagesInBatches = async (imagePaths, barcode) => {
//   const results = [];
//   const limited = imagePaths.slice(0, MAX_IMAGES_PER_VARIANT);

//   for (let i = 0; i < limited.length; i += CLOUDINARY_BATCH_SIZE) {
//     const batch   = limited.slice(i, i + CLOUDINARY_BATCH_SIZE);
//     const settled = await Promise.allSettled(
//       batch.map((imgPath, j) =>
//         uploadImageWithRetry(imgPath, `product_${barcode}_${i + j + 1}`)
//       )
//     );
//     settled.forEach(s => {
//       if (s.status === 'fulfilled') results.push(s.value);
//       else results.push({ success: false, error: s.reason?.message });
//     });
//   }
//   return results;
// };

// // Build barcode → folderPath map from extracted ZIP directory
// // Handles: __MACOSX, hidden files, duplicate folders, trailing spaces, case
// const buildFolderMap = async (extractDir) => {
//   const folderMap = new Map();
//   let scanDir     = extractDir;

//   const entries = await fsp.readdir(extractDir, { withFileTypes: true });

//   // Auto-detect wrapper folder (e.g. admin zipped "warehouse/" instead of its contents)
//   const realFolders = entries.filter(e =>
//     e.isDirectory() &&
//     !SKIP_FOLDERS.includes(e.name.toLowerCase()) &&
//     !e.name.startsWith('.')
//   );

//   if (realFolders.length === 1) {
//     const innerPath    = path.join(extractDir, realFolders[0].name);
//     const innerEntries = await fsp.readdir(innerPath, { withFileTypes: true });
//     const innerFolders = innerEntries.filter(e =>
//       e.isDirectory() &&
//       !SKIP_FOLDERS.includes(e.name.toLowerCase()) &&
//       !e.name.startsWith('.')
//     );
//     if (innerFolders.length > 0) {
//       console.log(`[BULK] Wrapper folder "${realFolders[0].name}" detected — scanning inside it`);
//       scanDir = innerPath;
//     }
//   }

//   const finalEntries = await fsp.readdir(scanDir, { withFileTypes: true });

//   for (const entry of finalEntries) {
//     if (SKIP_FOLDERS.includes(entry.name.toLowerCase())) continue;
//     if (entry.name.startsWith('.'))                      continue;

//     const fullPath = path.join(scanDir, entry.name);

//     // Handle nested zip files (e.g. admin zipped each barcode folder individually)
//     if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.zip') {
//       const baseName  = path.basename(entry.name, '.zip');
//       const extractTo = path.join(scanDir, baseName);
//       try {
//         await new Promise((resolve, reject) => {
//           fs.createReadStream(fullPath)
//             .pipe(unzipper.Extract({ path: extractTo }))
//             .on('close', resolve)
//             .on('error', reject);
//         });
//         const normKey = normaliseBarcode(baseName);
//         if (normKey && !folderMap.has(normKey)) {
//           folderMap.set(normKey, extractTo);
//           console.log(`[BULK] Extracted nested ZIP "${entry.name}" -> "${baseName}"`);
//         }
//       } catch (e) {
//         console.warn(`[BULK] Failed to extract nested ZIP "${entry.name}": ${e.message}`);
//       }
//       continue;
//     }

//     if (!entry.isDirectory()) continue;

//     const normKey = normaliseBarcode(entry.name);
//     if (!normKey) continue;

//     if (folderMap.has(normKey)) {
//       console.warn(`[BULK] Duplicate barcode folder "${normKey}" — keeping first`);
//     } else {
//       folderMap.set(normKey, fullPath);
//     }
//   }

//   return folderMap;
// };

// // Get valid image files from a folder — skip HEIC/TIFF etc.
// // Also handles case where images are inside a sub-folder (e.g. folderPath/images/img.jpg)
// const getValidImages = async (folderPath) => {
//   const entries  = await fsp.readdir(folderPath, { withFileTypes: true });
//   const valid    = [];
//   const skipped  = [];

//   for (const entry of entries) {
//     if (entry.name.startsWith('.')) continue;

//     const fullPath = path.join(folderPath, entry.name);

//     if (entry.isDirectory()) {
//       // Recurse one level into sub-folders (handles nested image dirs)
//       try {
//         const subEntries = await fsp.readdir(fullPath, { withFileTypes: true });
//         for (const sub of subEntries) {
//           if (sub.name.startsWith('.')) continue;
//           const ext = path.extname(sub.name).toLowerCase();
//           const subPath = path.join(fullPath, sub.name);
//           if (SUPPORTED_IMAGE_EXTS.includes(ext)) {
//             valid.push(subPath);
//           } else if (sub.isFile()) {
//             skipped.push({ file: sub.name, reason: `unsupported format ${ext} — convert to jpg/png/webp` });
//           }
//         }
//       } catch (e) {
//         skipped.push({ file: entry.name, reason: `could not read sub-folder: ${e.message}` });
//       }
//       continue;
//     }

//     const ext = path.extname(entry.name).toLowerCase();
//     if (SUPPORTED_IMAGE_EXTS.includes(ext)) {
//       valid.push(fullPath);
//     } else if (ext === '' || ext === '.zip') {
//       // Likely a zipped sub-folder (no extension or .zip) — try to extract and scan
//       const extractName = entry.name.replace(/\.zip$/i, '');
//       const extractTo   = path.join(folderPath, '_extracted_' + extractName);
//       try {
//         await new Promise((resolve, reject) => {
//           fs.createReadStream(fullPath)
//             .pipe(unzipper.Extract({ path: extractTo }))
//             .on('close', resolve)
//             .on('error', reject);
//         });
//         // Scan extracted dir for images (one level deep)
//         const subEntries = await fsp.readdir(extractTo, { withFileTypes: true });
//         for (const sub of subEntries) {
//           if (sub.name.startsWith('.')) continue;
//           const subExt  = path.extname(sub.name).toLowerCase();
//           const subPath = path.join(extractTo, sub.name);
//           if (SUPPORTED_IMAGE_EXTS.includes(subExt)) {
//             valid.push(subPath);
//           }
//         }
//         if (valid.length === 0) {
//           skipped.push({ file: entry.name, reason: `extracted but found no jpg/png/webp images inside` });
//         }
//       } catch (e) {
//         skipped.push({ file: entry.name, reason: `not a valid zip and not an image — convert to jpg/png/webp` });
//       }
//     } else {
//       skipped.push({ file: entry.name, reason: `unsupported format ${ext} — convert to jpg/png/webp` });
//     }
//   }

//   return { valid: valid.slice(0, MAX_IMAGES_PER_VARIANT), skipped };
// };

// // Safely remove a temp directory
// const cleanupDir = async (dirPath) => {
//   try {
//     await fsp.rm(dirPath, { recursive: true, force: true });
//   } catch (e) {
//     console.error(`[BULK] Cleanup failed for ${dirPath}:`, e.message);
//   }
// };

// // ═══════════════════════════════════════════════════════════════════════
// // STEP 1 — previewCSV
// // POST /admin/products/preview-csv
// // Replaces the old previewCSV — now handles CSV + Excel,
// // groups multi-row variants, validates, returns full preview.
// // NO DB writes. NO Cloudinary. Just parse + validate.
// // ═══════════════════════════════════════════════════════════════════════
// const previewCSV = async (req, res) => {
//   const filePath = req.file?.path;

//   try {
//     if (!filePath) {
//       return res.status(400).json({ success: false, message: 'No file uploaded' });
//     }

//     // ── Parse ──
//     let rows;
//     try {
//       rows = parseSpreadsheet(filePath);
//     } catch (e) {
//       return res.status(422).json({
//         success: false,
//         message: `Could not parse file: ${e.message}. Make sure it is a valid CSV or Excel file.`,
//       });
//     }

//     if (!rows.length) {
//       return res.status(422).json({ success: false, message: 'File appears to be empty' });
//     }

//     // ── Required column check ──
//     const firstRow     = rows[0];
//     const requiredCols = ['name', 'category', 'baseprice'];
//     const missing      = requiredCols.filter(c => !(c in firstRow));

//     if (missing.length) {
//       return res.status(422).json({
//         success    : false,
//         message    : `Missing required columns: ${missing.join(', ')}. Check headers and re-upload.`,
//         missingCols: missing,
//       });
//     }

//     // ── Group + validate ──
//     const products    = groupRowsIntoProducts(rows);
//     const validCount  = products.filter(p => validateProduct(p).length === 0).length;
//     const invalidCount= products.length - validCount;

//     const preview = products.map(prod => {
//       const errors = validateProduct(prod);
//       return {
//         name          : prod.name,
//         title         : prod.title,
//         category      : prod.category,
//         brand         : prod.brand,
//         status        : prod.status,
//         variantCount  : prod.variants.length,
//         barcodes      : prod.variants.map(v => v.barcode).filter(Boolean),
//         totalQuantity : prod.variants.reduce((s, v) => s + v.inventory.quantity, 0),
//         priceRange: {
//           min: Math.min(...prod.variants.map(v => v.price.sale ?? v.price.base)),
//           max: Math.max(...prod.variants.map(v => v.price.base)),
//         },
//         errors,
//         hasErrors: errors.length > 0,
//       };
//     });

//     return res.status(200).json({
//       success      : true,
//       message      : 'File parsed successfully',
//       totalRows    : rows.length,
//       totalProducts: products.length,
//       validCount,
//       invalidCount,
//       preview,
//       _parsedData  : products, // sent back to frontend, re-submitted in Step 2
//     });

//   } catch (err) {
//     console.error('[BULK:previewCSV]', err);
//     return res.status(500).json({ success: false, message: 'Server error during preview', error: err.message });
//   } finally {
//     if (filePath) fsp.unlink(filePath).catch(() => {});
//   }
// };

// // ═══════════════════════════════════════════════════════════════════════
// // STEP 2 — importProductsFromCSV  (kept same export name so routes.js unchanged)
// // POST /admin/products/import-csv
// // Now accepts: zipFile (optional) + products JSON body
// // Replaces the old URL-based image importer entirely.
// // ═══════════════════════════════════════════════════════════════════════
// const importProductsFromCSV = async (req, res) => {
//   const zipPath    = req.file?.path;  // multer puts zipFile here (same field logic)
//   const extractDir = path.join(os.tmpdir(), `bulk_${Date.now()}`);

//   const report = {
//     totalProducts  : 0,
//     savedProducts  : 0,
//     failedProducts : 0,
//     products       : [],
//   };

//   try {
//     // ── Parse products sent from frontend (from Step 1 preview) ──
//     let products;
//     try {
//       products = JSON.parse(req.body.products || '[]');
//     } catch {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid products data. Run CSV preview first then confirm import.',
//       });
//     }

//     if (!Array.isArray(products) || !products.length) {
//       return res.status(400).json({ success: false, message: 'No products to import' });
//     }

//     report.totalProducts = products.length;

//     // ── Extract ZIP and build barcode → folder map ──
//     let folderMap  = new Map();
//     let zipError   = null;

//     if (zipPath) {
//       try {
//         await new Promise((resolve, reject) => {
//           fs.createReadStream(zipPath)
//             .pipe(unzipper.Extract({ path: extractDir }))
//             .on('close', resolve)
//             .on('error', reject);
//         });
//         folderMap = await buildFolderMap(extractDir);
//         console.log(`[BULK] ZIP extracted. ${folderMap.size} barcode folder(s) found.`);
//       } catch (err) {
//         zipError = `ZIP extraction failed: ${err.message}. Products will be saved without images.`;
//         console.error('[BULK] ZIP extraction error:', err.message);
//       }
//     }

//     // ── Process each product ──
//     for (const prod of products) {
//       const productResult = {
//         name      : prod.name,
//         status    : 'pending',
//         imageCount: 0,
//         warnings  : [],
//         errors    : [],
//       };

//       try {
//         // Server-side re-validation (never trust client data)
//         const validationErrors = validateProduct(prod);
//         if (validationErrors.length) {
//           productResult.status = 'failed';
//           productResult.errors = validationErrors;
//           report.products.push(productResult);
//           report.failedProducts++;
//           continue;
//         }

//         // ── Find or create category ──
//         const categorySlug = slugify(prod.category, { lower: true, strict: true });
//         let category = await Category.findOne({ slug: categorySlug });
//         if (!category) {
//           category = await Category.create({
//             name  : prod.category,
//             slug  : categorySlug,
//             status: 'active',
//             level : 0,
//           });
//         }

//         // ── Process variants ──
//         const processedVariants = [];

//         for (const variant of prod.variants) {
//           const variantWarnings = [];
//           const variantImages   = [];
//           const normBarcode     = normaliseBarcode(variant.barcode);

//           // ── Image lookup & upload ──
//           if (!normBarcode) {
//             variantWarnings.push('Variant has no barcode — saved without images');
//           } else if (folderMap.size === 0 && zipPath) {
//             // ZIP was provided but extraction failed
//             variantWarnings.push('ZIP extraction failed — saved without images');
//           } else if (!folderMap.has(normBarcode)) {
//             if (folderMap.size > 0) {
//               // Give admin exact info to fix it
//               const sample = [...folderMap.keys()].slice(0, 8).join(', ');
//               variantWarnings.push(
//                 `Barcode "${variant.barcode}" folder not found in ZIP. ` +
//                 `Available folders: [${sample}]. ` +
//                 `Tip: check for leading zeros, trailing spaces, or case issues.`
//               );
//               console.warn(
//                 `[BULK] Folder mismatch — product: "${prod.name}", ` +
//                 `barcode: "${variant.barcode}", normalised: "${normBarcode}", ` +
//                 `available: [${sample}]`
//               );
//             }
//             // If no ZIP provided at all → silent, no warning (images optional)
//           } else {
//             // Folder found — get valid images
//             const folderPath = folderMap.get(normBarcode);
//             let validImages, skippedImages;

//             try {
//               ({ valid: validImages, skipped: skippedImages } = await getValidImages(folderPath));
//             } catch (readErr) {
//               variantWarnings.push(`Could not read image folder for "${variant.barcode}": ${readErr.message}`);
//               validImages   = [];
//               skippedImages = [];
//             }

//             // Log unsupported formats (HEIC etc.)
//             skippedImages.forEach(s => {
//               variantWarnings.push(`Skipped "${s.file}": ${s.reason}`);
//               console.warn(`[BULK] Skipped — barcode: "${variant.barcode}", file: "${s.file}"`);
//             });

//             if (validImages.length === 0 && skippedImages.length === 0) {
//               variantWarnings.push(`Folder for "${variant.barcode}" is empty — saved without images`);
//             }

//             // Upload to Cloudinary in batches
//             if (validImages.length > 0) {
//               const uploadResults = await uploadImagesInBatches(validImages, normBarcode);

//               uploadResults.forEach((r, i) => {
//                 if (r.success) {
//                   variantImages.push({
//                     url      : r.url,
//                     publicId : r.publicId,
//                     altText  : `${prod.name} image ${i + 1}`,
//                     order    : i,
//                   });
//                   productResult.imageCount++;
//                 } else {
//                   variantWarnings.push(
//                     `Image ${i + 1} upload failed for "${variant.barcode}": ${r.error} ` +
//                     `(tried ${r.attempts} time(s))`
//                   );
//                   console.error(
//                     `[BULK] Cloudinary failed — barcode: "${variant.barcode}", ` +
//                     `img: ${i + 1}, error: ${r.error}`
//                   );
//                 }
//               });
//             }
//           }

//           productResult.warnings.push(...variantWarnings);

//           // ── Build variant for DB ──
//           const slug   = await generateSlug(prod.name);
//           const skuVal = await generateSku();

//           processedVariants.push({
//             sku       : skuVal,
//             barcode   : variant.barcode ? Number(variant.barcode) || variant.barcode : undefined,
//             attributes: variant.variantAttributes || [],
//             price     : { base: variant.price.base, sale: variant.price.sale },
//             inventory : variant.inventory,
//             images    : variantImages,
//             isActive  : variant.isActive ?? true,
//           });
//         }

//         // ── Price range + stock ──
//         const effectivePrices = processedVariants.map(v =>
//           v.price.sale != null ? v.price.sale : v.price.base
//         );
//         const totalStock = processedVariants.reduce((s, v) => s + (v.inventory.quantity || 0), 0);

//         const slug = await generateSlug(prod.name);

//         const product = new Product({
//           name       : prod.name,
//           slug,
//           title      : prod.title,
//           description: prod.description || '',
//           category   : category._id,
//           brand      : prod.brand || 'Generic',
//           variants   : processedVariants,
//           priceRange : { min: Math.min(...effectivePrices), max: Math.max(...effectivePrices) },
//           totalStock,
//           soldInfo   : prod.soldInfo,
//           fomo       : prod.fomo,
//           shipping   : prod.shipping,
//           attributes : prod.productAttributes || [],
//           isFeatured : prod.isFeatured ?? false,
//           status     : prod.status || 'draft',
//         });

//         await product.save();

//         productResult.status = productResult.warnings.length ? 'saved_with_warnings' : 'success';
//         report.savedProducts++;

//       } catch (productErr) {
//         // Per-product failure — NEVER crashes the whole batch
//         productResult.status = 'failed';
//         productResult.errors.push(productErr.message);
//         report.failedProducts++;
//         console.error(`[BULK] Product failed — "${prod.name}":`, productErr.message);
//       }

//       report.products.push(productResult);
//     }

//     return res.status(201).json({
//       success       : true,
//       message       : 'Bulk import completed',
//       totalRows     : report.totalProducts,
//       insertedProducts: report.savedProducts,
//       failedCount   : report.failedProducts,
//       zipError,
//       products      : report.products, // full per-product report for frontend
//     });

//   } catch (err) {
//     console.error('[BULK:importProductsFromCSV] Fatal:', err);
//     return res.status(500).json({ success: false, message: 'Bulk import failed', error: err.message });
//   } finally {
//     if (zipPath) fsp.unlink(zipPath).catch(() => {});
//     await cleanupDir(extractDir);
//   }
// };

// // ═══════════════════════════════════════════════════════════════════════
// // ALL OTHER CONTROLLERS BELOW — 100% UNCHANGED
// // ═══════════════════════════════════════════════════════════════════════

// // Create new product
// const createProduct = async (req, res) => {
//   try {
//     const {
//       name, title, description, category, brand, status,
//       isFeatured, soldInfo, fomo, shipping, attributes, variants: variantsRaw
//     } = req.body;

//     if (!name || !title || !category) {
//       return res.status(400).json({ success: false, message: "Name, title and category are required" });
//     }

//     if (!mongoose.Types.ObjectId.isValid(category)) {
//       return res.status(400).json({ success: false, message: "Invalid category ID format" });
//     }

//     const existingCategory = await Category.findById(category);
//     if (!existingCategory) {
//       return res.status(400).json({ success: false, message: "Selected category does not exist." });
//     }

//     let variantsInput = variantsRaw;
//     if (typeof variantsRaw === "string") variantsInput = JSON.parse(variantsRaw);

//     const slug = await generateSlug(name);
//     const variants = [];
//     const filesByVariant = {};

//     if (req.files && req.files.length > 0) {
//       for (const file of req.files) {
//         const match = file.fieldname.match(/^variantImages_(\d+)$/);
//         if (match) {
//           const index = Number(match[1]);
//           if (!filesByVariant[index]) filesByVariant[index] = [];
//           filesByVariant[index].push(file);
//         }
//       }
//     }

//     for (const idxStr of Object.keys(filesByVariant)) {
//       if (filesByVariant[Number(idxStr)].length > 5) {
//         return res.status(400).json({ success: false, message: `Variant ${idxStr} can have at most 5 images` });
//       }
//     }

//     for (let i = 0; i < variantsInput.length; i++) {
//       const v = variantsInput[i];

//       if (!v.barcode) {
//         return res.status(400).json({ success: false, message: `Barcode is required for variant ${i}` });
//       }

//       const barcodeNumber = Number(v.barcode);
//       if (isNaN(barcodeNumber)) {
//         return res.status(400).json({ success: false, message: `Barcode must be a valid number for variant ${i}` });
//       }

//       const existingBarcode = await Product.findOne({ "variants.barcode": barcodeNumber });
//       if (existingBarcode) {
//         return res.status(400).json({ success: false, message: `Barcode ${barcodeNumber} already exists` });
//       }

//       const skuVal = await generateSku();
//       const priceObj = {
//         base: Number(v.price?.base) || 0,
//         sale: v.price?.sale != null ? Number(v.price.sale) : null,
//       };

//       if (priceObj.sale != null && priceObj.sale >= priceObj.base) {
//         return res.status(400).json({ success: false, message: `Sale price must be less than base price for variant ${i}` });
//       }

//       const inventoryObj = {
//         quantity         : Number(v.inventory?.quantity) || 0,
//         trackInventory   : v.inventory?.trackInventory !== false,
//         lowStockThreshold: v.inventory?.lowStockThreshold || 5,
//       };

//       const variantImages = [];

//       if (filesByVariant[i]) {
//         for (let imgIndex = 0; imgIndex < filesByVariant[i].length; imgIndex++) {
//           const file = filesByVariant[i][imgIndex];
//           const optimizedBuffer = await sharp(file.buffer)
//             .resize({ width: 1500, withoutEnlargement: true })
//             .webp({ quality: 80 })
//             .toBuffer();
//           const publicIdName = `${slug}_${skuVal}_img${imgIndex + 1}_${Date.now()}`;
//           const { url, publicId } = await uploadToCloudinary(optimizedBuffer, `products/${slug}`, publicIdName);
//           variantImages.push({ url, publicId, altText: `${name} ${skuVal} image ${imgIndex + 1}`, order: imgIndex });
//         }
//       }

//       variants.push({
//         sku      : skuVal,
//         barcode  : barcodeNumber,
//         attributes: Array.isArray(v.attributes) ? v.attributes.map(a => ({ key: a.key, value: a.value })) : [],
//         price    : priceObj,
//         inventory: inventoryObj,
//         images   : variantImages,
//         isActive : v.isActive !== false,
//       });
//     }

//     const effectivePrices = variants.map(v => v.price.sale != null ? v.price.sale : v.price.base);
//     const minPrice  = Math.min(...effectivePrices);
//     const maxPrice  = Math.max(...effectivePrices);
//     const totalStock= variants.reduce((sum, v) => sum + (v.inventory.quantity || 0), 0);

//     let parsedSoldInfo = soldInfo, parsedFomo = fomo, parsedShipping = shipping, parsedAttributes = attributes;
//     try {
//       if (typeof soldInfo   === "string") parsedSoldInfo   = JSON.parse(soldInfo);
//       if (typeof fomo       === "string") parsedFomo       = JSON.parse(fomo);
//       if (typeof shipping   === "string") parsedShipping   = JSON.parse(shipping);
//       if (typeof attributes === "string") parsedAttributes = JSON.parse(attributes);
//     } catch {
//       return res.status(400).json({ success: false, message: "Invalid JSON format in request body" });
//     }

//     const product = new Product({
//       name, slug, title,
//       description: description || "",
//       category   : existingCategory._id,
//       brand      : brand || "Generic",
//       variants,
//       priceRange : { min: minPrice, max: maxPrice },
//       totalStock,
//       isFeatured : isFeatured || false,
//       soldInfo   : parsedSoldInfo || { enabled: false, count: 0 },
//       fomo       : parsedFomo    || { enabled: false, type: "viewing_now", viewingNow: 0 },
//       shipping   : parsedShipping || { weight: 0, dimensions: { length: 0, width: 0, height: 0 } },
//       attributes : parsedAttributes || [],
//       status     : status || "draft",
//     });

//     await product.save();

//     return res.status(201).json({ success: true, message: "Product created successfully", product, categoryDetails: existingCategory.name });
//   } catch (error) {
//     console.error("Create product error:", error);
//     return res.status(500).json({ success: false, message: "Error creating product", error: error.message });
//   }
// };

// // Bulk create products (for testing)
// const bulkCreateProducts = async (req, res) => {
//   try {
//     const { products } = req.body;
//     if (!Array.isArray(products) || products.length === 0) {
//       return res.status(400).json({ success: false, message: "products array is required" });
//     }

//     const createdProducts = [];
//     const failedProducts  = [];

//     for (let item of products) {
//       try {
//         if (!item.name || !item.title || !item.category) throw new Error("Missing required fields");

//         const slug = await generateSlug(item.name);
//         const parseIfString = (value) => {
//           if (typeof value === "string") { try { return JSON.parse(value); } catch { return value; } }
//           return value;
//         };

//         const soldInfoInput   = parseIfString(item.soldInfo)    || {};
//         const fomoInput       = parseIfString(item.fomo)        || {};
//         const shippingInput   = parseIfString(item.shipping)    || {};
//         const attributesInput = parseIfString(item.attributes)  || [];
//         const variantsInput   = parseIfString(item.variants);

//         let variants = [];

//         if (Array.isArray(variantsInput) && variantsInput.length > 0) {
//           variants = variantsInput.map((v, index) => {
//             const basePrice = Number(v.price?.base || 0);
//             const salePrice = v.price?.sale != null ? Number(v.price.sale) : null;
//             if (salePrice && salePrice >= basePrice) throw new Error("Invalid sale price");
//             return {
//               sku       : v.sku ? String(v.sku).toUpperCase() : `${slug}-VAR${index + 1}`.toUpperCase(),
//               attributes: Array.isArray(v.attributes) ? v.attributes.map(a => ({ key: a.key, value: a.value })) : [],
//               price     : { base: basePrice, sale: salePrice },
//               inventory : { quantity: Number(v.inventory?.quantity ?? 0), trackInventory: v.inventory?.trackInventory ?? true, lowStockThreshold: Number(v.inventory?.lowStockThreshold ?? 5) },
//               images    : [],
//               isActive  : v.isActive ?? true,
//             };
//           });
//         } else {
//           const basePrice = Number(item.price?.base || item.price || 0);
//           variants.push({
//             sku: `${slug}-VAR1`.toUpperCase(), attributes: [],
//             price: { base: basePrice, sale: null },
//             inventory: { quantity: Number(item.inventory?.quantity ?? 0), trackInventory: item.inventory?.trackInventory ?? true, lowStockThreshold: Number(item.inventory?.lowStockThreshold ?? 5) },
//             images: [], isActive: true,
//           });
//         }

//         const effectivePrices = variants.map(v => v.price.sale != null ? v.price.sale : v.price.base);
//         const product = new Product({
//           name: item.name, slug, title: item.title, description: item.description || "",
//           category: item.category, brand: item.brand || "Generic", variants,
//           priceRange: { min: Math.min(...effectivePrices), max: Math.max(...effectivePrices) },
//           totalStock: variants.reduce((sum, v) => sum + (v.inventory.quantity || 0), 0),
//           soldInfo  : { enabled: soldInfoInput.enabled ?? false, count: Number(soldInfoInput.count ?? 0) },
//           fomo      : { enabled: fomoInput.enabled ?? false, type: fomoInput.type || "viewing_now", viewingNow: Number(fomoInput.viewingNow ?? 0), productLeft: Number(fomoInput.productLeft ?? 0), customMessage: fomoInput.customMessage || "" },
//           shipping  : { weight: Number(shippingInput.weight ?? 0), dimensions: { length: Number(shippingInput.dimensions?.length ?? 0), width: Number(shippingInput.dimensions?.width ?? 0), height: Number(shippingInput.dimensions?.height ?? 0) } },
//           attributes: Array.isArray(attributesInput) ? attributesInput.map(attr => ({ key: attr.key, value: attr.value })) : [],
//           isFeatured: item.isFeatured ?? false, status: item.status || "draft",
//         });

//         await product.save();
//         createdProducts.push(product);
//       } catch (err) {
//         failedProducts.push({ name: item.name || "Unknown", error: err.message });
//       }
//     }

//     return res.status(201).json({ success: true, message: "Bulk product creation completed", totalRequested: products.length, createdCount: createdProducts.length, failedCount: failedProducts.length, failedProducts });
//   } catch (error) {
//     console.error("Bulk create error:", error);
//     return res.status(500).json({ success: false, message: "Error creating products", error: error.message });
//   }
// };

// const updateProduct = async (req, res) => {
//   try {
//     const slug = req.params.slug;
//     const existingProduct = await Product.findOne({ slug });
//     if (!existingProduct) return res.status(404).json({ success: false, message: "Product not found" });

//     const updates = { ...req.body };
//     delete updates.slug;
//     delete updates.sku;
//     delete updates.variants;

//     const parseIfString = (value, fallback) => {
//       if (typeof value === "string") { try { return JSON.parse(value); } catch { return fallback; } }
//       return value;
//     };

//     if (updates.barcode) {
//       const barcodeNumber = Number(updates.barcode);
//       if (isNaN(barcodeNumber)) return res.status(400).json({ success: false, message: "Invalid barcode" });

//       const variantIndex = existingProduct.variants.findIndex(v => v.barcode === barcodeNumber);
//       if (variantIndex === -1) return res.status(404).json({ success: false, message: "No product found with this barcode" });

//       const existingVariant = existingProduct.variants[variantIndex];
//       const updateFields    = {};

//       if (updates.price) {
//         const parsedPrice = parseIfString(updates.price, {});
//         const base = parsedPrice.base !== undefined ? Number(parsedPrice.base) : existingVariant.price.base;
//         const sale = parsedPrice.sale !== undefined ? (parsedPrice.sale != null ? Number(parsedPrice.sale) : null) : existingVariant.price.sale;
//         if (sale != null && sale >= base) return res.status(400).json({ success: false, message: "Sale price must be less than base price" });
//         if (parsedPrice.base !== undefined) updateFields["variants.$.price.base"] = base;
//         if (parsedPrice.sale !== undefined) updateFields["variants.$.price.sale"] = sale;
//       }

//       if (updates.inventory) {
//         const parsedInventory = parseIfString(updates.inventory, {});
//         if (parsedInventory.quantity          !== undefined) updateFields["variants.$.inventory.quantity"]          = Number(parsedInventory.quantity);
//         if (parsedInventory.lowStockThreshold !== undefined) updateFields["variants.$.inventory.lowStockThreshold"] = Number(parsedInventory.lowStockThreshold);
//         if (parsedInventory.trackInventory    !== undefined) updateFields["variants.$.inventory.trackInventory"]    = parsedInventory.trackInventory;
//       }

//       const hasNewFiles       = req.files && req.files.length > 0;
//       const existingImagesRaw = updates.existingImages;

//       if (hasNewFiles) {
//         if (existingVariant.images && existingVariant.images.length > 0) {
//           for (const img of existingVariant.images) { if (img.publicId) await deleteFromCloudinary(img.publicId); }
//         }
//         const uploadedImages = [];
//         for (let i = 0; i < req.files.length; i++) {
//           const file = req.files[i];
//           if (!file.buffer) continue;
//           const uploadResult = await uploadToCloudinary(file.buffer, "products");
//           uploadedImages.push({ url: uploadResult.url, publicId: uploadResult.publicId, altText: existingProduct.name, order: i });
//         }
//         updateFields["variants.$.images"] = uploadedImages;
//       } else if (existingImagesRaw) {
//         try {
//           const reordered = parseIfString(existingImagesRaw, null);
//           if (Array.isArray(reordered) && reordered.length > 0) {
//             updateFields["variants.$.images"] = reordered.map((img, i) => ({ url: img.url || "", publicId: img.publicId || "", altText: img.altText || existingProduct.name, order: i }));
//           }
//         } catch (e) { console.warn("existingImages parse error:", e.message); }
//       }

//       if (updates.isActive !== undefined) updateFields["variants.$.isActive"] = updates.isActive === true || updates.isActive === "true";

//       if (updates.attributes) {
//         const parsedAttributes = parseIfString(updates.attributes, []);
//         if (Array.isArray(parsedAttributes)) updateFields["variants.$.attributes"] = parsedAttributes.map(a => ({ key: a.key, value: a.value }));
//       }

//       const updatedProduct = await Product.findOneAndUpdate({ slug, "variants.barcode": barcodeNumber }, { $set: updateFields }, { new: true });
//       const effectivePrices = updatedProduct.variants.map(v => v.price.sale != null ? v.price.sale : v.price.base);
//       updatedProduct.priceRange = { min: Math.min(...effectivePrices), max: Math.max(...effectivePrices) };
//       updatedProduct.totalStock = updatedProduct.variants.reduce((sum, v) => sum + (v.inventory.quantity || 0), 0);
//       await updatedProduct.save();
//       return res.status(200).json({ success: true, message: "Variant updated successfully", product: updatedProduct });
//     }

//     if (updates.name && updates.name !== existingProduct.name) updates.slug = await generateSlug(updates.name, existingProduct._id);

//     if (updates.soldInfo) {
//       const parsed = parseIfString(updates.soldInfo, {});
//       updates.soldInfo = { ...existingProduct.soldInfo.toObject(), ...parsed, enabled: parsed.enabled === true || parsed.enabled === "true", count: Number(parsed.count ?? 0) };
//     }
//     if (updates.fomo) {
//       const parsed = parseIfString(updates.fomo, {});
//       updates.fomo = { ...existingProduct.fomo.toObject(), ...parsed, enabled: parsed.enabled === true || parsed.enabled === "true", viewingNow: Number(parsed.viewingNow ?? 0), productLeft: Number(parsed.productLeft ?? 0), type: ["viewing_now", "product_left", "custom"].includes(parsed.type) ? parsed.type : existingProduct.fomo.type };
//     }
//     if (updates.shipping) {
//       const parsed = parseIfString(updates.shipping, {});
//       updates.shipping = { ...existingProduct.shipping.toObject(), ...parsed, weight: Number(parsed.weight ?? 0), dimensions: { length: Number(parsed.dimensions?.length ?? 0), width: Number(parsed.dimensions?.width ?? 0), height: Number(parsed.dimensions?.height ?? 0) } };
//     }
//     if (updates.attributes) {
//       const parsed = parseIfString(updates.attributes, []);
//       updates.attributes = Array.isArray(parsed) ? parsed.map(a => ({ key: a.key, value: a.value })) : [];
//     }

//     const updatedProduct = await Product.findByIdAndUpdate(existingProduct._id, { $set: updates }, { new: true, runValidators: true });
//     return res.status(200).json({ success: true, message: "Product updated successfully", product: updatedProduct });
//   } catch (error) {
//     console.error("Update product error:", error);
//     return res.status(500).json({ success: false, message: "Error updating product", error: error.message });
//   }
// };

// const deleteProduct = async (req, res) => {
//   try {
//     const { slug } = req.params;
//     const product  = await Product.findOneAndUpdate({ slug, status: { $ne: "archived" } }, { $set: { status: "archived" } }, { new: true });
//     if (!product) return res.status(404).json({ success: false, message: "Product not found or already archived" });
//     return res.status(200).json({ success: true, message: "Product archived successfully", product });
//   } catch (error) {
//     console.error("Archive product error:", error);
//     return res.status(500).json({ success: false, message: "Error archiving product", error: error.message });
//   }
// };

// const bulkDelete = async (req, res) => {
//   try {
//     let { slugs } = req.body;
//     if (!Array.isArray(slugs) || slugs.length === 0) return res.status(400).json({ success: false, message: "slugs array is required" });
//     slugs = slugs.filter(slug => typeof slug === "string" && slug.trim() !== "").map(slug => slug.trim());
//     if (!slugs.length) return res.status(400).json({ success: false, message: "No valid slugs provided" });
//     if (slugs.length > 500) return res.status(400).json({ success: false, message: "Maximum 500 products allowed per request" });
//     const result = await Product.updateMany({ slug: { $in: slugs }, status: { $ne: "archived" } }, { $set: { status: "archived", archivedAt: new Date() } });
//     return res.status(200).json({ success: true, message: "Bulk archive completed", requested: slugs.length, archived: result.modifiedCount, skipped: slugs.length - result.modifiedCount });
//   } catch (error) {
//     console.error("Bulk archive error:", error);
//     return res.status(500).json({ success: false, message: "Error archiving products", error: error.message });
//   }
// };

// const restoreProduct = async (req, res) => {
//   try {
//     const { slug } = req.params;
//     const product  = await Product.findOneAndUpdate({ slug, status: "archived" }, { $set: { status: "active" }, $unset: { archivedAt: "" } }, { new: true });
//     if (!product) return res.status(404).json({ success: false, message: "Archived product not found" });
//     return res.status(200).json({ success: true, message: "Product restored successfully", product });
//   } catch (error) {
//     console.error("Restore product error:", error);
//     return res.status(500).json({ success: false, message: "Error restoring product", error: error.message });
//   }
// };

// const bulkRestore = async (req, res) => {
//   try {
//     let { slugs } = req.body;
//     if (!Array.isArray(slugs) || slugs.length === 0) return res.status(400).json({ success: false, message: "slugs array is required" });
//     slugs = slugs.filter(slug => typeof slug === "string" && slug.trim() !== "").map(slug => slug.trim());
//     if (!slugs.length) return res.status(400).json({ success: false, message: "No valid slugs provided" });
//     if (slugs.length > 500) return res.status(400).json({ success: false, message: "Maximum 500 products allowed per request" });
//     const result = await Product.updateMany({ slug: { $in: slugs }, status: "archived" }, { $set: { status: "active" }, $unset: { archivedAt: "" } });
//     return res.status(200).json({ success: true, message: "Bulk restore completed", requested: slugs.length, restored: result.modifiedCount, skipped: slugs.length - result.modifiedCount });
//   } catch (error) {
//     console.error("Bulk restore error:", error);
//     return res.status(500).json({ success: false, message: "Error restoring products", error: error.message });
//   }
// };

// const getLowStockProducts = async (req, res) => {
//   try {
//     let { page = 1, limit = 20 } = req.query;
//     const pageNumber  = Math.max(1, Number(page));
//     const limitNumber = Math.min(100, Number(limit));
//     const skip = (pageNumber - 1) * limitNumber;
//     const query = { status: "active", $expr: { $anyElementTrue: { $map: { input: "$variants", as: "variant", in: { $and: [{ $eq: ["$$variant.inventory.trackInventory", true] }, { $gt: ["$$variant.inventory.quantity", 0] }, { $lte: ["$$variant.inventory.quantity", "$$variant.inventory.lowStockThreshold"] }] } } } } };
//     const [products, total] = await Promise.all([Product.find(query).sort({ "variants.inventory.quantity": 1 }).skip(skip).limit(limitNumber), Product.countDocuments(query)]);
//     return res.status(200).json({ success: true, total, page: pageNumber, limit: limitNumber, count: products.length, products });
//   } catch (error) {
//     console.error("Low stock products error:", error);
//     return res.status(500).json({ success: false, message: "Error fetching low stock products", error: error.message });
//   }
// };

// const getAllActiveProducts = async (req, res) => {
//   try {
//     let { page = 1, limit = 20 } = req.query;
//     const pageNumber  = Math.max(1, Number(page));
//     const limitNumber = Math.min(100, Number(limit));
//     const skip = (pageNumber - 1) * limitNumber;
//     const query = { status: "active" };
//     const [products, total] = await Promise.all([Product.find(query).populate("category", "name").sort({ createdAt: -1 }).skip(skip).limit(limitNumber).lean(), Product.countDocuments(query)]);
//     return res.status(200).json({ success: true, total, page: pageNumber, limit: limitNumber, count: products.length, products });
//   } catch (error) {
//     console.error("Get all products error:", error);
//     return res.status(500).json({ success: false, message: "Error fetching products", error: error.message });
//   }
// };

// const getProductBySlug = async (req, res) => {
//   try {
//     const slug = req.params.slug?.trim();
//     if (!slug) return res.status(400).json({ success: false, message: "Invalid product slug" });
//     const product = await Product.findOne({ slug, status: "active" }).populate("category", "name").lean();
//     if (!product) return res.status(404).json({ success: false, message: "Product not found" });
//     return res.status(200).json({ success: true, product });
//   } catch (error) {
//     console.error("Get product by slug error:", error);
//     return res.status(500).json({ success: false, message: "Error fetching product", error: error.message });
//   }
// };

// const getArchivedProducts = async (req, res) => {
//   try {
//     let { page = 1, limit = 20 } = req.query;
//     const pageNumber  = Math.max(1, Number(page));
//     const limitNumber = Math.min(100, Number(limit));
//     const skip = (pageNumber - 1) * limitNumber;
//     const [products, total] = await Promise.all([Product.find({ status: "archived" }).populate("category", "name").sort({ createdAt: -1 }).skip(skip).limit(limitNumber).lean(), Product.countDocuments({ status: "archived" })]);
//     return res.status(200).json({ success: true, total, page: pageNumber, limit: limitNumber, count: products.length, products });
//   } catch (error) {
//     return res.status(500).json({ success: false, message: "Error fetching archived products", error: error.message });
//   }
// };

// const getDraftProducts = async (req, res) => {
//   try {
//     let { page = 1, limit = 20 } = req.query;
//     const pageNumber  = Math.max(1, Number(page));
//     const limitNumber = Math.min(100, Number(limit));
//     const skip = (pageNumber - 1) * limitNumber;
//     const [products, total] = await Promise.all([Product.find({ status: "draft" }).populate("category", "name").sort({ createdAt: -1 }).skip(skip).limit(limitNumber).lean(), Product.countDocuments({ status: "draft" })]);
//     return res.status(200).json({ success: true, total, page: pageNumber, limit: limitNumber, count: products.length, products });
//   } catch (error) {
//     return res.status(500).json({ success: false, message: "Error fetching draft products", error: error.message });
//   }
// };

// const hardDeleteProduct = async (req, res) => {
//   try {
//     const { slug } = req.params;
//     if (!slug) return res.status(400).json({ success: false, message: "Invalid product slug" });
//     const product = await Product.findOne({ slug }).lean();
//     if (!product) return res.status(404).json({ success: false, message: "Product not found" });
//     if (product.status !== "archived") return res.status(400).json({ success: false, message: "Only archived products can be permanently deleted" });
//     const publicIds = [];
//     if (Array.isArray(product.images))   product.images.forEach(img => { if (img.publicId) publicIds.push(img.publicId); });
//     if (Array.isArray(product.variants)) product.variants.forEach(v => { if (Array.isArray(v.images)) v.images.forEach(img => { if (img.publicId) publicIds.push(img.publicId); }); });
//     await Promise.all([...new Set(publicIds)].map(id => deleteFromCloudinary(id).catch(err => console.error("Cloudinary delete failed:", id))));
//     await Product.deleteOne({ _id: product._id });
//     return res.status(200).json({ success: true, message: "Product permanently deleted" });
//   } catch (error) {
//     console.error("Hard delete product error:", error);
//     return res.status(500).json({ success: false, message: "Error permanently deleting product", error: error.message });
//   }
// };

// const bulkHardDelete = async (req, res) => {
//   try {
//     const { slugs } = req.body;
//     if (!Array.isArray(slugs) || slugs.length === 0) return res.status(400).json({ success: false, message: "slugs array is required" });
//     const products = await Product.find({ slug: { $in: slugs }, status: "archived" }).lean();
//     if (!products.length) return res.status(404).json({ success: false, message: "No archived products found to delete" });
//     const publicIds = [];
//     for (const product of products) {
//       if (Array.isArray(product.images))   product.images.forEach(img => { if (img.publicId) publicIds.push(img.publicId); });
//       if (Array.isArray(product.variants)) product.variants.forEach(v => { if (Array.isArray(v.images)) v.images.forEach(img => { if (img.publicId) publicIds.push(img.publicId); }); });
//     }
//     if (publicIds.length > 0) await Promise.allSettled(publicIds.map(id => deleteFromCloudinary(id)));
//     const deleteResult = await Product.deleteMany({ _id: { $in: products.map(p => p._id) } });
//     return res.status(200).json({ success: true, message: "Products permanently deleted", requested: slugs.length, deletedCount: deleteResult.deletedCount, skipped: slugs.length - deleteResult.deletedCount });
//   } catch (error) {
//     console.error("Bulk hard delete error:", error);
//     return res.status(500).json({ success: false, message: "Error permanently deleting products", error: error.message });
//   }
// };

// const getAllProductsAdmin = async (req, res) => {
//   try {
//     let { page = 1, limit = 20 } = req.query;
//     page  = Number(page);
//     limit = Math.min(100, Math.max(1, Number(limit)));
//     const skip = (page - 1) * limit;
//     const products      = await Product.find().sort({ createdAt: -1 }).skip(skip).limit(limit);
//     const totalProducts = await Product.countDocuments();
//     return res.status(200).json({ success: true, totalProducts, totalPages: Math.ceil(totalProducts / limit), currentPage: page, products });
//   } catch (error) {
//     console.error("Get all products error:", error);
//     return res.status(500).json({ success: false, message: "Error fetching products", error: error.message });
//   }
// };

// const getAdminProducts = async (req, res) => {
//   try {
//     const products = await Product.find();
//     return res.status(200).json({ success: true, products });
//   } catch (error) {
//     console.error("Get admin products error:", error);
//     return res.status(500).json({ success: false, message: "Error fetching admin products", error: error.message });
//   }
// };

// const addVariant = async (req, res) => {
//   try {
//     const { slug }  = req.params;
//     const product   = await Product.findOne({ slug });
//     if (!product) return res.status(404).json({ success: false, message: "Product not found" });

//     let variant = { ...req.body };
//     const parseIfString = (value, fallback) => {
//       if (typeof value === "string") { try { return JSON.parse(value); } catch { return fallback; } }
//       return value;
//     };

//     if (variant.price)      variant.price      = parseIfString(variant.price, {});
//     if (variant.attributes) variant.attributes = parseIfString(variant.attributes, []);
//     if (variant.inventory)  variant.inventory  = parseIfString(variant.inventory, {});

//     if (!variant.barcode) return res.status(400).json({ success: false, message: "Barcode is required" });
//     const barcodeNumber = Number(variant.barcode);
//     if (isNaN(barcodeNumber)) return res.status(400).json({ success: false, message: "Barcode must be a valid number" });
//     const barcodeExists = await Product.exists({ "variants.barcode": barcodeNumber });
//     if (barcodeExists) return res.status(400).json({ success: false, message: "Variant with this barcode already exists" });
//     if (!variant.price?.base) return res.status(400).json({ success: false, message: "Base price is required" });

//     const basePrice = Number(variant.price.base);
//     if (isNaN(basePrice) || basePrice <= 0) return res.status(400).json({ success: false, message: "Base price must be a valid number greater than 0" });

//     const salePrice = variant.price.sale != null ? Number(variant.price.sale) : null;
//     if (salePrice !== null && (isNaN(salePrice) || salePrice >= basePrice)) return res.status(400).json({ success: false, message: "Sale price must be a valid number less than base price" });

//     const skuVal = await generateSku();
//     let uploadedImages = [];

//     if (req.files && req.files.length > 0) {
//       for (let i = 0; i < req.files.length; i++) {
//         const file = req.files[i];
//         if (!file.buffer) continue;
//         const uploadResult = await uploadToCloudinary(file.buffer, "products");
//         uploadedImages.push({ url: uploadResult.url, publicId: uploadResult.publicId, altText: product.name, order: i });
//       }
//     }

//     const newVariant = {
//       sku      : skuVal,
//       barcode  : barcodeNumber,
//       attributes: Array.isArray(variant.attributes) ? variant.attributes.filter(a => a.key && a.value).map(a => ({ key: a.key, value: a.value })) : [],
//       price    : { base: basePrice, sale: salePrice },
//       inventory: { quantity: Number(variant.inventory?.quantity || 0), lowStockThreshold: Number(variant.inventory?.lowStockThreshold || 5), trackInventory: variant.inventory?.trackInventory !== false },
//       images   : uploadedImages,
//       isActive : variant.isActive !== false,
//     };

//     product.variants.push(newVariant);
//     const effectivePrices = product.variants.map(v => v.price.sale != null ? v.price.sale : v.price.base);
//     product.priceRange    = { min: Math.min(...effectivePrices), max: Math.max(...effectivePrices) };
//     product.totalStock    = product.variants.reduce((sum, v) => sum + (v.inventory.quantity || 0), 0);
//     await product.save();

//     return res.status(200).json({ success: true, message: "Variant added successfully", product });
//   } catch (error) {
//     console.error("Add variant error:", error);
//     return res.status(500).json({ success: false, message: "Error adding variant", error: error.message });
//   }
// };

// const deleteVariant = async (req, res) => {
//   try {
//     const { slug }  = req.params;
//     const { barcode } = req.body;
//     if (!barcode) return res.status(400).json({ success: false, message: "Barcode is required" });
//     const barcodeNumber = Number(barcode);
//     if (isNaN(barcodeNumber)) return res.status(400).json({ success: false, message: "Invalid barcode" });
//     const product = await Product.findOne({ slug });
//     if (!product) return res.status(404).json({ success: false, message: "Product not found" });
//     if (!product.variants.some(v => v.barcode === barcodeNumber)) return res.status(404).json({ success: false, message: "Variant not found" });
//     if (product.variants.length === 1) return res.status(400).json({ success: false, message: "Cannot delete last variant of product" });
//     product.variants = product.variants.filter(v => v.barcode !== barcodeNumber);
//     const effectivePrices = product.variants.map(v => v.price.sale != null ? v.price.sale : v.price.base);
//     product.priceRange    = { min: Math.min(...effectivePrices), max: Math.max(...effectivePrices) };
//     product.totalStock    = product.variants.reduce((sum, v) => sum + (v.inventory.quantity || 0), 0);
//     await product.save();
//     return res.status(200).json({ success: true, message: "Variant deleted successfully", product });
//   } catch (error) {
//     console.error("Delete variant error:", error);
//     return res.status(500).json({ success: false, message: "Error deleting variant", error: error.message });
//   }
// };

// const getVariantByBarcode = async (req, res) => {
//   try {
//     const { barcode } = req.params;
//     if (!barcode) return res.status(400).json({ success: false, message: "Barcode is required" });
//     const barcodeNumber = Number(barcode);
//     if (isNaN(barcodeNumber)) return res.status(400).json({ success: false, message: "Invalid barcode" });
//     const product = await Product.findOne({ "variants.barcode": barcodeNumber }, { name: 1, slug: 1, brand: 1, category: 1, fomo: 1, soldInfo: 1, "variants.$": 1 });
//     if (!product) return res.status(404).json({ success: false, message: "No product found for this barcode" });
//     return res.status(200).json({ success: true, product: { _id: product._id, name: product.name, slug: product.slug, brand: product.brand, category: product.category, fomo: product.fomo, soldInfo: product.soldInfo }, variant: product.variants[0] });
//   } catch (error) {
//     console.error("Get variant by barcode error:", error);
//     return res.status(500).json({ success: false, message: "Error fetching variant", error: error.message });
//   }
// };

// module.exports = {
//   createProduct,
//   updateProduct,
//   deleteProduct,
//   bulkDelete,
//   hardDeleteProduct,
//   bulkHardDelete,
//   restoreProduct,
//   getLowStockProducts,
//   getArchivedProducts,
//   getDraftProducts,
//   getAllActiveProducts,
//   getProductBySlug,
//   bulkCreateProducts,
//   bulkRestore,
//   importProductsFromCSV,  // Step 2 — now handles ZIP + products JSON
//   getAllProductsAdmin,
//   addVariant,
//   deleteVariant,
//   getVariantByBarcode,
//   previewCSV,             // Step 1 — now handles CSV + Excel properly
// };

// karan changes upload images in exel using links >>>>>>>>>>>>>>>>>>
// const { cloudinary , initCloudinary } = require('../config/cloudinary.config');
// const Product = require('../models/Product');
// const Category = require('../models/Category');
// const mongoose = require('mongoose');
// const slugify = require('slugify');
// const { generateSlug, generateSku } = require('../utils/productUtils');
// const { uploadToCloudinary, deleteFromCloudinary } = require('../utils/cloudinaryHelper');
// const sharp = require('sharp');
// const fs = require('fs');
// const csv = require('csv-parser');
// const unzipper = require('unzipper');
// const path = require('path');
// const axios = require('axios');
// const xlsx     = require('xlsx'); // npm install xlsx


// // ─────────────────────────────────────────────────────────────
// // BULK UPLOAD CONSTANTS
// // ─────────────────────────────────────────────────────────────
// const MAX_IMAGES_PER_VARIANT = 5;
// const CLOUDINARY_BATCH_SIZE  = 5;
// const CLOUDINARY_RETRY_MAX   = 2;
// const SUPPORTED_IMAGE_EXTS   = ['.jpg', '.jpeg', '.png', '.webp'];
// const SKIP_FOLDERS           = ['__macosx', '.ds_store', 'thumbs.db'];
 
// // ─────────────────────────────────────────────────────────────
// // HELPERS
// // ─────────────────────────────────────────────────────────────
 
// // Normalise barcode — handles: BOM, encoding garbage (cafÃ©), trim,
// // lowercase, leading zeros preserved as string
// const normaliseBarcode = (raw) => {
//   if (raw === null || raw === undefined) return '';
//   return String(raw)
//     .replace(/^\uFEFF/, '')        // strip BOM
//     .replace(/[^\x20-\x7E]/g, '') // strip non-ASCII (encoding disasters)
//     .trim()
//     .toLowerCase();
// };
 
// // Strip Excel BOM from header strings
// const stripBOM = (str) => String(str || '').replace(/^\uFEFF/, '');
 
// // Parse spreadsheet (CSV, XLS, XLSX) → plain row objects
// // All header keys lowercased + trimmed so "basePrice" === "baseprice" === "BasePrice"
// const parseSpreadsheet = (filePath) => {
//   const wb   = xlsx.readFile(filePath, { raw: false, defval: '' });
//   const ws   = wb.Sheets[wb.SheetNames[0]];
//   const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
 
//   return rows.map(row => {
//     const clean = {};
//     for (const [k, v] of Object.entries(row)) {
//       const key    = stripBOM(k).trim().toLowerCase();
//       clean[key]   = typeof v === 'string' ? v.trim() : String(v ?? '').trim();
//     }
//     return clean;
//   });
// };
 
// // Parse "Color:Black|Size:L" → [{key,value}]
// const parseAttributes = (raw) => {
//   if (!raw || !String(raw).trim()) return [];
//   return String(raw).split('|').map(pair => {
//     const [key, ...rest] = pair.split(':');
//     return { key: (key || '').trim(), value: rest.join(':').trim() };
//   }).filter(a => a.key && a.value);
// };
 
// // Group CSV rows → products (multi-row = multi-variant)
// const groupRowsIntoProducts = (rows) => {
//   const map   = new Map();
//   const order = [];
 
//   rows.forEach((row, idx) => {
//     const name = (row.name || '').trim();
//     if (!name) return;
 
//     // Preserve barcode as string — leading zeros must survive
//     const barcode = String(row.barcode || '').trim();
 
//     const variant = {
//       barcode,
//       variantAttributes : parseAttributes(row.variantattributes || row.variantAttributes || ''),
//       price: {
//         base: Number((row.baseprice  || row.basePrice  || '0').replace(/[^0-9.]/g, '') || 0),
//         sale: (row.saleprice || row.salePrice)
//           ? Number((row.saleprice || row.salePrice).replace(/[^0-9.]/g, '') || 0)
//           : null,
//       },
//       inventory: {
//         quantity          : Number(row.quantity || 0),
//         trackInventory    : String(row.trackinventory || 'true').toLowerCase() !== 'false',
//         lowStockThreshold : Number(row.lowstockthreshold || 5),
//       },
//       images   : [],
//       isActive : String(row.isactive || 'true').toLowerCase() !== 'false',
//       _rowIndex: idx + 2, // 1-based + header row — used in error messages
//     };
 
//     if (!map.has(name)) {
//       order.push(name);
//       map.set(name, {
//         name,
//         title             : (row.title || name).trim(),
//         description       : (row.description || '').trim(),
//         category          : (row.category || '').trim(),
//         brand             : (row.brand || 'Generic').trim(),
//         status            : (row.status || 'draft').toLowerCase().trim(),
//         isFeatured        : String(row.isfeatured || 'false').toLowerCase() === 'true',
//         productAttributes : parseAttributes(row.productattributes || row.productAttributes || ''),
//         soldInfo: {
//           enabled: String(row.soldenabled || row.soldEnabled || 'false').toLowerCase() === 'true',
//           count  : Number(row.soldcount   || row.soldCount   || 0),
//         },
//         fomo: {
//           enabled      : String(row.fomoenabled || row.fomoEnabled || 'false').toLowerCase() === 'true',
//           type         : (row.fomotype || row.fomoType || 'viewing_now').trim(),
//           viewingNow   : Number(row.viewingnow   || row.viewingNow   || 0),
//           productLeft  : Number(row.productleft  || row.productLeft  || 0),
//           customMessage: (row.custommessage || row.customMessage || '').trim(),
//         },
//         shipping: {
//           weight    : Number(row.weight || 0),
//           dimensions: {
//             length: Number(row.length || 0),
//             width : Number(row.width  || 0),
//             height: Number(row.height || 0),
//           },
//         },
//         variants: [],
//       });
//     }
 
//     map.get(name).variants.push(variant);
//   });
 
//   return order.map(n => map.get(n));
// };
 
// // Validate a single product — returns [] if clean
// const validateProduct = (prod) => {
//   const errs = [];
//   if (!prod.name)     errs.push('name is required');
//   if (!prod.category) errs.push('category is required');
//   prod.variants.forEach((v, i) => {
//     if (!v.price.base || v.price.base <= 0)
//       errs.push(`variant ${i + 1} (row ${v._rowIndex}): basePrice must be > 0`);
//     if (v.price.sale !== null && v.price.sale >= v.price.base)
//       errs.push(`variant ${i + 1} (row ${v._rowIndex}): salePrice must be less than basePrice`);
//   });
//   return errs;
// };
 
// // Upload one image to Cloudinary with retry + exponential backoff
// const uploadImageWithRetry = async (imgPath, publicId, attempt = 1) => {
//   try {
//     const result = await uploadToCloudinary(imgPath, {
//       public_id : publicId,
//       folder    : 'products/bulk',
//       overwrite : true,
//     });
//     return { success: true, url: result.secure_url, publicId: result.public_id };
//   } catch (err) {
//     if (attempt < CLOUDINARY_RETRY_MAX) {
//       await new Promise(r => setTimeout(r, 1000 * attempt));
//       return uploadImageWithRetry(imgPath, publicId, attempt + 1);
//     }
//     return { success: false, error: err.message, attempts: attempt };
//   }
// };
 
// // Upload images in parallel batches — never sequential, never blows rate limit
// const uploadImagesInBatches = async (imagePaths, barcode) => {
//   const results = [];
//   const limited = imagePaths.slice(0, MAX_IMAGES_PER_VARIANT);
 
//   for (let i = 0; i < limited.length; i += CLOUDINARY_BATCH_SIZE) {
//     const batch   = limited.slice(i, i + CLOUDINARY_BATCH_SIZE);
//     const settled = await Promise.allSettled(
//       batch.map((imgPath, j) =>
//         uploadImageWithRetry(imgPath, `product_${barcode}_${i + j + 1}`)
//       )
//     );
//     settled.forEach(s => {
//       if (s.status === 'fulfilled') results.push(s.value);
//       else results.push({ success: false, error: s.reason?.message });
//     });
//   }
//   return results;
// };
 
// // Build barcode → folderPath map from extracted ZIP directory
// // Handles: __MACOSX, hidden files, duplicate folders, trailing spaces, case
// const buildFolderMap = async (extractDir) => {
//   const folderMap = new Map();
//   const entries   = await fsp.readdir(extractDir, { withFileTypes: true });
 
//   for (const entry of entries) {
//     if (!entry.isDirectory())                          continue;
//     if (SKIP_FOLDERS.includes(entry.name.toLowerCase())) continue;
//     if (entry.name.startsWith('.'))                    continue;
 
//     const normKey = normaliseBarcode(entry.name);
//     if (!normKey) continue;
 
//     if (folderMap.has(normKey)) {
//       console.warn(`[BULK] Duplicate barcode folder "${normKey}" — keeping first`);
//     } else {
//       folderMap.set(normKey, path.join(extractDir, entry.name));
//     }
//   }
 
//   return folderMap;
// };
 
// // Get valid image files from a folder — skip HEIC/TIFF etc.
// const getValidImages = async (folderPath) => {
//   const files   = await fsp.readdir(folderPath);
//   const valid   = [];
//   const skipped = [];
 
//   for (const f of files) {
//     if (f.startsWith('.')) continue;
//     const ext = path.extname(f).toLowerCase();
//     if (SUPPORTED_IMAGE_EXTS.includes(ext)) {
//       valid.push(path.join(folderPath, f));
//     } else {
//       skipped.push({ file: f, reason: `unsupported format ${ext} — convert to jpg/png/webp` });
//     }
//   }
 
//   return { valid: valid.slice(0, MAX_IMAGES_PER_VARIANT), skipped };
// };
 
// // Safely remove a temp directory
// const cleanupDir = async (dirPath) => {
//   try {
//     await fsp.rm(dirPath, { recursive: true, force: true });
//   } catch (e) {
//     console.error(`[BULK] Cleanup failed for ${dirPath}:`, e.message);
//   }
// };
 



// // Create new product
// // Create new product
// const createProduct = async (req, res) => {
//   try {
//     const {
//       name,
//       title,
//       description,
//       category,
//       brand,
//       status,
//       isFeatured,
//       soldInfo,
//       fomo,
//       shipping,
//       attributes,
//       variants: variantsRaw
//     } = req.body;

//     if (!name || !title || !category) {
//       return res.status(400).json({
//         success: false,
//         message: "Name, title and category are required"
//       });
//     }

//     if (!mongoose.Types.ObjectId.isValid(category)) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid category ID format"
//       });
//     }

//     const existingCategory = await Category.findById(category);
//     if (!existingCategory) {
//       return res.status(400).json({
//         success: false,
//         message: "Selected category does not exist."
//       });
//     }

//     let variantsInput = variantsRaw;
//     if (typeof variantsRaw === "string") {
//       variantsInput = JSON.parse(variantsRaw);
//     }

//     // if (!Array.isArray(variantsInput) || variantsInput.length === 0) {
//     //   return res.status(400).json({
//     //     success: false,
//     //     message: "At least one variant is required"
//     //   });
//     // }

//     const slug = await generateSlug(name);
//     const variants = [];
//     const filesByVariant = {};

//     // =============================
//     // Group variant images
//     // =============================
//     if (req.files && req.files.length > 0) {
//       for (const file of req.files) {
//         const match = file.fieldname.match(/^variantImages_(\d+)$/);
//         if (match) {
//           const index = Number(match[1]);
//           if (!filesByVariant[index]) filesByVariant[index] = [];
//           filesByVariant[index].push(file);
//         }
//       }
//     }

//     for (const idxStr of Object.keys(filesByVariant)) {
//       const idx = Number(idxStr);
//       if (filesByVariant[idx].length > 5) {
//         return res.status(400).json({
//           success: false,
//           message: `Variant ${idx} can have at most 5 images`
//         });
//       }
//     }

//     // =============================
//     // PROCESS EACH VARIANT
//     // =============================
//     for (let i = 0; i < variantsInput.length; i++) {
//       const v = variantsInput[i];

//       // 🔒 BARCODE REQUIRED
//       if (!v.barcode) {
//         return res.status(400).json({
//           success: false,
//           message: `Barcode is required for variant ${i}`
//         });
//       }

//       const barcodeNumber = Number(v.barcode);
//       if (isNaN(barcodeNumber)) {
//         return res.status(400).json({
//           success: false,
//           message: `Barcode must be a valid number for variant ${i}`
//         });
//       }

//       // 🔒 CHECK DUPLICATE BARCODE IN DB
//       const existingBarcode = await Product.findOne({
//         "variants.barcode": barcodeNumber
//       });

//       if (existingBarcode) {
//         return res.status(400).json({
//           success: false,
//           message: `Barcode ${barcodeNumber} already exists`
//         });
//       }

//       // 🔥 AUTO GENERATE SKU
//       const skuVal = await generateSku();

//       const priceObj = {
//         base: Number(v.price?.base) || 0,
//         sale: v.price?.sale != null ? Number(v.price.sale) : null
//       };

//       if (priceObj.sale != null && priceObj.sale >= priceObj.base) {
//         return res.status(400).json({
//           success: false,
//           message: `Sale price must be less than base price for variant ${i}`
//         });
//       }

//       const inventoryObj = {
//         quantity: Number(v.inventory?.quantity) || 0,
//         trackInventory: v.inventory?.trackInventory !== false,
//         lowStockThreshold: v.inventory?.lowStockThreshold || 5
//       };

//       const variantImages = [];

//       // =============================
//       // Upload Variant Images
//       // =============================
//       if (filesByVariant[i]) {
//         for (let imgIndex = 0; imgIndex < filesByVariant[i].length; imgIndex++) {
//           const file = filesByVariant[i][imgIndex];

//           const optimizedBuffer = await sharp(file.buffer)
//             .resize({ width: 1500, withoutEnlargement: true })
//             .webp({ quality: 80 })
//             .toBuffer();

//           const publicIdName = `${slug}_${skuVal}_img${imgIndex + 1}_${Date.now()}`;

//           const { url, publicId } = await uploadToCloudinary(
//             optimizedBuffer,
//             `products/${slug}`,
//             publicIdName
//           );

//           variantImages.push({
//             url,
//             publicId,
//             altText: `${name} ${skuVal} image ${imgIndex + 1}`,
//             order: imgIndex
//           });
//         }
//       }

//       variants.push({
//         sku: skuVal, // ✅ FROM UTILS
//         barcode: barcodeNumber,
//         attributes: Array.isArray(v.attributes)
//           ? v.attributes.map(a => ({ key: a.key, value: a.value }))
//           : [],
//         price: priceObj,
//         inventory: inventoryObj,
//         images: variantImages,
//         isActive: v.isActive !== false
//       });
//     }

//     // =============================
//     // Price Range & Stock
//     // =============================
//     const effectivePrices = variants.map(v =>
//       v.price.sale != null ? v.price.sale : v.price.base
//     );

//     const minPrice = Math.min(...effectivePrices);
//     const maxPrice = Math.max(...effectivePrices);

//     const totalStock = variants.reduce(
//       (sum, v) => sum + (v.inventory.quantity || 0),
//       0
//     );

//     // =============================
//     // Parse Optional JSON Fields
//     // =============================
//     let parsedSoldInfo = soldInfo;
//     let parsedFomo = fomo;
//     let parsedShipping = shipping;
//     let parsedAttributes = attributes;

//     try {
//       if (typeof soldInfo === "string") parsedSoldInfo = JSON.parse(soldInfo);
//       if (typeof fomo === "string") parsedFomo = JSON.parse(fomo);
//       if (typeof shipping === "string") parsedShipping = JSON.parse(shipping);
//       if (typeof attributes === "string") parsedAttributes = JSON.parse(attributes);
//     } catch {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid JSON format in request body"
//       });
//     }

//     const product = new Product({
//       name,
//       slug,
//       title,
//       description: description || "",
//       category: existingCategory._id,
//       brand: brand || "Generic",
//       variants,
//       priceRange: { min: minPrice, max: maxPrice },
//       totalStock,
//       isFeatured: isFeatured || false,
//       soldInfo: parsedSoldInfo || { enabled: false, count: 0 },
//       fomo: parsedFomo || { enabled: false, type: "viewing_now", viewingNow: 0 },
//       shipping: parsedShipping || {
//         weight: 0,
//         dimensions: { length: 0, width: 0, height: 0 }
//       },
//       attributes: parsedAttributes || [],
//       status: status || "draft"
//     });

//     await product.save();

//     return res.status(201).json({
//       success: true,
//       message: "Product created successfully",
//       product,
//       categoryDetails: existingCategory.name
//     });

//   } catch (error) {
//     console.error("Create product error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error creating product",
//       error: error.message
//     });
//   }
// };

// //Bulk create products (for testing)
// const bulkCreateProducts = async (req, res) => {
//   try {
//     const { products } = req.body;

//     if (!Array.isArray(products) || products.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "products array is required"
//       });
//     }

//     const createdProducts = [];
//     const failedProducts = [];

//     for (let item of products) {
//       try {
//         if (!item.name || !item.title || !item.category) {
//           throw new Error("Missing required fields");
//         }

//         const slug = await generateSlug(item.name);

//         // =========================
//         // PARSE NESTED OBJECTS (SAFE)
//         // =========================
//         const parseIfString = (value) => {
//           if (typeof value === "string") {
//             try {
//               return JSON.parse(value);
//             } catch {
//               return value;
//             }
//           }
//           return value;
//         };

//         const soldInfoInput = parseIfString(item.soldInfo) || {};
//         const fomoInput = parseIfString(item.fomo) || {};
//         const shippingInput = parseIfString(item.shipping) || {};
//         const attributesInput = parseIfString(item.attributes) || [];
//         const variantsInput = parseIfString(item.variants);

//         // =========================
//         // VARIANTS (SUPPORT BOTH TYPES)
//         // =========================
//         let variants = [];

//         if (Array.isArray(variantsInput) && variantsInput.length > 0) {
//           variants = variantsInput.map((v, index) => {
//             const basePrice = Number(v.price?.base || 0);
//             const salePrice =
//               v.price?.sale != null ? Number(v.price.sale) : null;

//             if (salePrice && salePrice >= basePrice) {
//               throw new Error("Invalid sale price");
//             }

//             return {
//               sku: v.sku
//                 ? String(v.sku).toUpperCase()
//                 : `${slug}-VAR${index + 1}`.toUpperCase(),
//               attributes: Array.isArray(v.attributes)
//                 ? v.attributes.map(a => ({
//                     key: a.key,
//                     value: a.value
//                   }))
//                 : [],
//               price: {
//                 base: basePrice,
//                 sale: salePrice
//               },
//               inventory: {
//                 quantity: Number(v.inventory?.quantity ?? 0),
//                 trackInventory: v.inventory?.trackInventory ?? true,
//                 lowStockThreshold:
//                   Number(v.inventory?.lowStockThreshold ?? 5)
//               },
//               images: [],
//               isActive: v.isActive ?? true
//             };
//           });
//         } else {
//           // If no variants provided, create single variant
//           const basePrice = Number(item.price?.base || item.price || 0);

//           variants.push({
//             sku: `${slug}-VAR1`.toUpperCase(),
//             attributes: [],
//             price: { base: basePrice, sale: null },
//             inventory: {
//               quantity: Number(item.inventory?.quantity ?? 0),
//               trackInventory: item.inventory?.trackInventory ?? true,
//               lowStockThreshold:
//                 Number(item.inventory?.lowStockThreshold ?? 5)
//             },
//             images: [],
//             isActive: true
//           });
//         }

//         // =========================
//         // CALCULATE PRICE RANGE
//         // =========================
//         const effectivePrices = variants.map(v =>
//           v.price.sale != null ? v.price.sale : v.price.base
//         );

//         const minPrice = Math.min(...effectivePrices);
//         const maxPrice = Math.max(...effectivePrices);

//         const totalStock = variants.reduce(
//           (sum, v) => sum + (v.inventory.quantity || 0),
//           0
//         );

//         // =========================
//         // CREATE PRODUCT
//         // =========================
//         const product = new Product({
//           name: item.name,
//           slug,
//           title: item.title,
//           description: item.description || "",
//           category: item.category,
//           brand: item.brand || "Generic",

//           variants,
//           priceRange: {
//             min: minPrice,
//             max: maxPrice
//           },
//           totalStock,

//           soldInfo: {
//             enabled: soldInfoInput.enabled ?? false,
//             count: Number(soldInfoInput.count ?? 0)
//           },

//           fomo: {
//             enabled: fomoInput.enabled ?? false,
//             type: fomoInput.type || "viewing_now",
//             viewingNow: Number(fomoInput.viewingNow ?? 0),
//             productLeft: Number(fomoInput.productLeft ?? 0),
//             customMessage: fomoInput.customMessage || ""
//           },

//           shipping: {
//             weight: Number(shippingInput.weight ?? 0),
//             dimensions: {
//               length: Number(shippingInput.dimensions?.length ?? 0),
//               width: Number(shippingInput.dimensions?.width ?? 0),
//               height: Number(shippingInput.dimensions?.height ?? 0)
//             }
//           },

//           attributes: Array.isArray(attributesInput)
//             ? attributesInput.map(attr => ({
//                 key: attr.key,
//                 value: attr.value
//               }))
//             : [],

//           isFeatured: item.isFeatured ?? false,
//           status: item.status || "draft"
//         });

//         await product.save();
//         createdProducts.push(product);

//       } catch (err) {
//         failedProducts.push({
//           name: item.name || "Unknown",
//           error: err.message
//         });
//       }
//     }

//     return res.status(201).json({
//       success: true,
//       message: "Bulk product creation completed",
//       totalRequested: products.length,
//       createdCount: createdProducts.length,
//       failedCount: failedProducts.length,
//       failedProducts
//     });

//   } catch (error) {
//     console.error("Bulk create error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error creating products",
//       error: error.message
//     });
//   }
// };



// //Bulk create from CSV (for testing)

// // ═══════════════════════════════════════════════════════════════════════
// // STEP 2 — importProductsFromCSV  (kept same export name so routes.js unchanged)
// // POST /admin/products/import-csv
// // Now accepts: zipFile (optional) + products JSON body
// // Replaces the old URL-based image importer entirely.
// // ═══════════════════════════════════════════════════════════════════════
// const importProductsFromCSV = async (req, res) => {
//   const zipPath    = req.file?.path;  // multer puts zipFile here (same field logic)
//   const extractDir = path.join(os.tmpdir(), `bulk_${Date.now()}`);
 
//   const report = {
//     totalProducts  : 0,
//     savedProducts  : 0,
//     failedProducts : 0,
//     products       : [],
//   };
 
//   try {
//     // ── Parse products sent from frontend (from Step 1 preview) ──
//     let products;
//     try {
//       products = JSON.parse(req.body.products || '[]');
//     } catch {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid products data. Run CSV preview first then confirm import.',
//       });
//     }
 
//     if (!Array.isArray(products) || !products.length) {
//       return res.status(400).json({ success: false, message: 'No products to import' });
//     }
 
//     report.totalProducts = products.length;
 
//     // ── Extract ZIP and build barcode → folder map ──
//     let folderMap  = new Map();
//     let zipError   = null;
 
//     if (zipPath) {
//       try {
//         await new Promise((resolve, reject) => {
//           fs.createReadStream(zipPath)
//             .pipe(unzipper.Extract({ path: extractDir }))
//             .on('close', resolve)
//             .on('error', reject);
//         });
//         folderMap = await buildFolderMap(extractDir);
//         console.log(`[BULK] ZIP extracted. ${folderMap.size} barcode folder(s) found.`);
//       } catch (err) {
//         zipError = `ZIP extraction failed: ${err.message}. Products will be saved without images.`;
//         console.error('[BULK] ZIP extraction error:', err.message);
//       }
//     }
 
//     // ── Process each product ──
//     for (const prod of products) {
//       const productResult = {
//         name      : prod.name,
//         status    : 'pending',
//         imageCount: 0,
//         warnings  : [],
//         errors    : [],
//       };
 
//       try {
//         // Server-side re-validation (never trust client data)
//         const validationErrors = validateProduct(prod);
//         if (validationErrors.length) {
//           productResult.status = 'failed';
//           productResult.errors = validationErrors;
//           report.products.push(productResult);
//           report.failedProducts++;
//           continue;
//         }
 
//         // ── Find or create category ──
//         const categorySlug = slugify(prod.category, { lower: true, strict: true });
//         let category = await Category.findOne({ slug: categorySlug });
//         if (!category) {
//           category = await Category.create({
//             name  : prod.category,
//             slug  : categorySlug,
//             status: 'active',
//             level : 0,
//           });
//         }
 
//         // ── Process variants ──
//         const processedVariants = [];
 
//         for (const variant of prod.variants) {
//           const variantWarnings = [];
//           const variantImages   = [];
//           const normBarcode     = normaliseBarcode(variant.barcode);
 
//           // ── Image lookup & upload ──
//           if (!normBarcode) {
//             variantWarnings.push('Variant has no barcode — saved without images');
//           } else if (folderMap.size === 0 && zipPath) {
//             // ZIP was provided but extraction failed
//             variantWarnings.push('ZIP extraction failed — saved without images');
//           } else if (!folderMap.has(normBarcode)) {
//             if (folderMap.size > 0) {
//               // Give admin exact info to fix it
//               const sample = [...folderMap.keys()].slice(0, 8).join(', ');
//               variantWarnings.push(
//                 `Barcode "${variant.barcode}" folder not found in ZIP. ` +
//                 `Available folders: [${sample}]. ` +
//                 `Tip: check for leading zeros, trailing spaces, or case issues.`
//               );
//               console.warn(
//                 `[BULK] Folder mismatch — product: "${prod.name}", ` +
//                 `barcode: "${variant.barcode}", normalised: "${normBarcode}", ` +
//                 `available: [${sample}]`
//               );
//             }
//             // If no ZIP provided at all → silent, no warning (images optional)
//           } else {
//             // Folder found — get valid images
//             const folderPath = folderMap.get(normBarcode);
//             let validImages, skippedImages;
 
//             try {
//               ({ valid: validImages, skipped: skippedImages } = await getValidImages(folderPath));
//             } catch (readErr) {
//               variantWarnings.push(`Could not read image folder for "${variant.barcode}": ${readErr.message}`);
//               validImages   = [];
//               skippedImages = [];
//             }
 
//             // Log unsupported formats (HEIC etc.)
//             skippedImages.forEach(s => {
//               variantWarnings.push(`Skipped "${s.file}": ${s.reason}`);
//               console.warn(`[BULK] Skipped — barcode: "${variant.barcode}", file: "${s.file}"`);
//             });
 
//             if (validImages.length === 0 && skippedImages.length === 0) {
//               variantWarnings.push(`Folder for "${variant.barcode}" is empty — saved without images`);
//             }
 
//             // Upload to Cloudinary in batches
//             if (validImages.length > 0) {
//               const uploadResults = await uploadImagesInBatches(validImages, normBarcode);
 
//               uploadResults.forEach((r, i) => {
//                 if (r.success) {
//                   variantImages.push({
//                     url      : r.url,
//                     publicId : r.publicId,
//                     altText  : `${prod.name} image ${i + 1}`,
//                     order    : i,
//                   });
//                   productResult.imageCount++;
//                 } else {
//                   variantWarnings.push(
//                     `Image ${i + 1} upload failed for "${variant.barcode}": ${r.error} ` +
//                     `(tried ${r.attempts} time(s))`
//                   );
//                   console.error(
//                     `[BULK] Cloudinary failed — barcode: "${variant.barcode}", ` +
//                     `img: ${i + 1}, error: ${r.error}`
//                   );
//                 }
//               });
//             }
//           }
 
//           productResult.warnings.push(...variantWarnings);
 
//           // ── Build variant for DB ──
//           const slug   = await generateSlug(prod.name);
//           const skuVal = await generateSku();
 
//           processedVariants.push({
//             sku       : skuVal,
//             barcode   : variant.barcode ? Number(variant.barcode) || variant.barcode : undefined,
//             attributes: variant.variantAttributes || [],
//             price     : { base: variant.price.base, sale: variant.price.sale },
//             inventory : variant.inventory,
//             images    : variantImages,
//             isActive  : variant.isActive ?? true,
//           });
//         }
 
//         // ── Price range + stock ──
//         const effectivePrices = processedVariants.map(v =>
//           v.price.sale != null ? v.price.sale : v.price.base
//         );
//         const totalStock = processedVariants.reduce((s, v) => s + (v.inventory.quantity || 0), 0);
 
//         const slug = await generateSlug(prod.name);
 
//         const product = new Product({
//           name       : prod.name,
//           slug,
//           title      : prod.title,
//           description: prod.description || '',
//           category   : category._id,
//           brand      : prod.brand || 'Generic',
//           variants   : processedVariants,
//           priceRange : { min: Math.min(...effectivePrices), max: Math.max(...effectivePrices) },
//           totalStock,
//           soldInfo   : prod.soldInfo,
//           fomo       : prod.fomo,
//           shipping   : prod.shipping,
//           attributes : prod.productAttributes || [],
//           isFeatured : prod.isFeatured ?? false,
//           status     : prod.status || 'draft',
//         });
 
//         await product.save();
 
//         productResult.status = productResult.warnings.length ? 'saved_with_warnings' : 'success';
//         report.savedProducts++;
 
//       } catch (productErr) {
//         // Per-product failure — NEVER crashes the whole batch
//         productResult.status = 'failed';
//         productResult.errors.push(productErr.message);
//         report.failedProducts++;
//         console.error(`[BULK] Product failed — "${prod.name}":`, productErr.message);
//       }
 
//       report.products.push(productResult);
//     }
 
//     return res.status(201).json({
//       success       : true,
//       message       : 'Bulk import completed',
//       totalRows     : report.totalProducts,
//       insertedProducts: report.savedProducts,
//       failedCount   : report.failedProducts,
//       zipError,
//       products      : report.products, // full per-product report for frontend
//     });
 
//   } catch (err) {
//     console.error('[BULK:importProductsFromCSV] Fatal:', err);
//     return res.status(500).json({ success: false, message: 'Bulk import failed', error: err.message });
//   } finally {
//     if (zipPath) fsp.unlink(zipPath).catch(() => {});
//     await cleanupDir(extractDir);
//   }
// };
// // const importProductsFromCSV = async (req, res) => {
// //   try {
// //     if (!req.file) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "CSV file is required",
// //       });
// //     }

// //     const rows = [];
// //     const failed = [];
// //     const productMap = {};

// //  fs.createReadStream(req.file.path)
// //   .pipe(
// //     csv({
// //       mapHeaders: ({ header }) => header.trim(),
// //     })
// //   )
// //       .on("data", (row) => rows.push(row))
// //       .on("end", async () => {
// //         try {
// //           for (let row of rows) {
// //             try {
// //               // ===============================
// //               // TRIM ALL VALUES
// //               // ===============================
// //               Object.keys(row).forEach((key) => {
// //                 if (typeof row[key] === "string") {
// //                   row[key] = row[key].trim();
// //                 }
// //               });

// //               // ===============================
// //               // REQUIRED FIELD VALIDATION
// //               // ===============================
// //               if (!row.name || !row.category || !row.basePrice) {
// //                 throw new Error("Missing required fields");
// //               }

// //               const productName = row.name;
// //               const baseSlug = slugify(productName, {
// //                 lower: true,
// //                 strict: true,
// //               });

// //               // ===============================
// //               // CREATE PRODUCT IF NOT EXISTS
// //               // ===============================
// //               if (!productMap[productName]) {
// //                 const slug = await generateSlug(productName);

// //                 // CATEGORY CHECK
// //                 const categorySlug = slugify(row.category, {
// //                   lower: true,
// //                   strict: true,
// //                 });

// //                 let category = await Category.findOne({
// //                   slug: categorySlug,
// //                 });

// //                 if (!category) {
// //                   category = await Category.create({
// //                     name: row.category,
// //                     slug: categorySlug,
// //                     status: "active",
// //                     level: 0,
// //                   });
// //                 }

// //                 productMap[productName] = {
// //                   name: productName,
// //                   slug,
// //                   title: row.title || productName,
// //                   description: row.description || "",
// //                   category: category._id,
// //                   brand: row.brand || "Generic",
// //                   status: row.status?.toLowerCase() || "draft",
// //                   isFeatured: row.isfeatured === "true",

// //                   variants: [],

// //                   soldInfo: {
// //                     enabled: row.soldEnabled === "true",
// //                     count: Number(row.soldCount) || 0,
// //                   },

// //                   fomo: {
// //                     enabled: row.fomoEnabled === "true",
// //                     type: row.fomoType || "viewing_now",
// //                     viewingNow: Number(row.viewingNow) || 0,
// //                     productLeft: Number(row.productLeft) || 0,
// //                     customMessage: row.customMessage || "",
// //                   },
// //                 };
// //               }

// //               // ===============================
// //               // VARIANT ATTRIBUTES
// //               // ===============================
// //               let variantAttributes = [];

// //               if (row.variantAttributes) {
// //                 variantAttributes = row.variantAttributes
// //                   .split("|")
// //                   .map((pair) => {
// //                     const [key, value] = pair.split(":");
// //                     return {
// //                       key: key?.trim(),
// //                       value: value?.trim(),
// //                     };
// //                   });
// //               }

// //               // ===============================
// //               // PRODUCT ATTRIBUTES (optional)
// //               // ===============================
// //               let productAttributes = [];

// //               if (row.productAttributes) {
// //                 productAttributes = row.productAttributes
// //                   .split("|")
// //                   .map((pair) => {
// //                     const [key, value] = pair.split(":");
// //                     return {
// //                       key: key?.trim(),
// //                       value: value?.trim(),
// //                     };
// //                   });
// //               }

// //               // ===============================
// //               // IMAGE UPLOAD FROM URL (max 5)
// //               // ===============================
// //               const axios = require("axios");

// // let imagesArr = [];

// // if (row.images) {
// //   const imageUrls = row.images
// //     .split(",")
// //     .map((u) => u.trim())
// //     .slice(0, 5);

// //   for (let url of imageUrls) {
// //     if (!url) continue;

// //     try {

// //       // 🔥 CASE 1: Already Base64
// //       if (url.startsWith("data:image")) {

// //         const uploadResult = await cloudinary.uploader.upload(url, {
// //           resource_type: "image"
// //         });

// //         imagesArr.push({
// //           url: uploadResult.secure_url,
// //           publicId: uploadResult.public_id,
// //           altText: productName,
// //           order: imagesArr.length
// //         });

// //       } 
      
// //       // 🔥 CASE 2: Normal URL
// //       else if (url.startsWith("http")) {

// //         const response = await axios({
// //           method: "GET",
// //           url: url,
// //           responseType: "arraybuffer",
// //           timeout: 15000,
// //           headers: {
// //             "User-Agent": "Mozilla/5.0"
// //           }
// //         });

// //         const base64 = Buffer.from(response.data).toString("base64");
// //         const mimeType = response.headers["content-type"];
// //         const dataURI = `data:${mimeType};base64,${base64}`;

// //         const uploadResult = await cloudinary.uploader.upload(dataURI, {
// //           resource_type: "image"
// //         });

// //         imagesArr.push({
// //           url: uploadResult.secure_url,
// //           publicId: uploadResult.public_id,
// //           altText: productName,
// //           order: imagesArr.length
// //         });
// //       }

// //     } catch (err) {
// //   console.log("Image upload failed:", url);
// //   console.log("ERROR:", err.message);
// // }
    
// //   }
// // }

// //               // ===============================
// //               // BUILD VARIANT OBJECT
// //               // ===============================
// //               const variant = {
// //                 sku:
// //                   "SKU-" +
// //                   Math.floor(100000 + Math.random() * 900000),
// //                 barcode: row.barcode || "",
// //                 attributes: variantAttributes,
// //                 weight: Number(row.weight) || 0,
// //                 dimensions: {
// //                   length: Number(row.length) || 0,
// //                   width: Number(row.width) || 0,
// //                   height: Number(row.height) || 0,
// //                 },
// //                 price: {
// //                   base: Number(row.basePrice),
// //                   sale: row.salePrice
// //                     ? Number(row.salePrice)
// //                     : null,
// //                 },
// //                 inventory: {
// //                   quantity: Number(row.quantity) || 0,
// //                   trackInventory: true,
// //                   lowStockThreshold: 5,
// //                 },
// //                 images: imagesArr,
// //                 isActive: true,
// //               };

// //               productMap[productName].variants.push(variant);

// //               // attach product attributes once
// //               if (
// //                 productAttributes.length &&
// //                 !productMap[productName].productAttributes
// //               ) {
// //                 productMap[productName].productAttributes =
// //                   productAttributes;
// //               }

// //             } catch (err) {
// //               failed.push({
// //                 product: row.name || "Unknown",
// //                 error: err.message,
// //               });
// //             }
// //           }

// //           // ===============================
// //           // INSERT INTO DATABASE
// //           // ===============================
// //           const finalProducts = Object.values(productMap);

// //           let inserted = [];

// //           if (finalProducts.length > 0) {
// //             inserted = await Product.insertMany(finalProducts);
// //           }

// //           fs.unlinkSync(req.file.path);

// //           return res.status(200).json({
// //             success: true,
// //             totalRows: rows.length,
// //             insertedProducts: inserted.length,
// //             failedCount: failed.length,
// //             failed,
// //           });
// //         } catch (err) {
// //           return res.status(500).json({
// //             success: false,
// //             message: "Processing failed",
// //             error: err.message,
// //           });
// //         }
// //       });
// //   } catch (error) {
// //     return res.status(500).json({
// //       success: false,
// //       message: "CSV import failed",
// //       error: error.message,
// //     });
// //   }
// // };
// // const importProductsFromCSV = async (req, res) => {
// //   try {
// //     if (!req.file) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "CSV file is required",
// //       });
// //     }

// //     const rows = [];
// //     const failed = [];
// //     const productMap = {};

// //     fs.createReadStream(req.file.path)
// //       .pipe(
// //         csv({
// //           mapHeaders: ({ header }) => header.trim(),
// //         })
// //       )
// //       .on("data", (row) => rows.push(row))
// //       .on("end", async () => {
// //         try {
// //           for (let row of rows) {
// //             try {
// //               // ===============================
// //               // TRIM ALL VALUES
// //               // ===============================
// //               Object.keys(row).forEach((key) => {
// //                 if (typeof row[key] === "string") {
// //                   row[key] = row[key].trim();
// //                 }
// //               });

// //               // ===============================
// //               // REQUIRED FIELD VALIDATION
// //               // ===============================
// //               if (!row.name || !row.category || !row.basePrice) {
// //                 throw new Error("Missing required fields");
// //               }

// //               const productName = row.name;

// //               // ===============================
// //               // 🔥 PRICE SANITIZATION (NEW FIX)
// //               // ===============================
// //               const cleanBasePrice = parseFloat(
// //                 row.basePrice?.replace(/[^0-9.]/g, "")
// //               );

// //               const cleanSalePrice = row.salePrice
// //                 ? parseFloat(row.salePrice.replace(/[^0-9.]/g, ""))
// //                 : null;

// //               if (isNaN(cleanBasePrice)) {
// //                 throw new Error("Invalid basePrice format");
// //               }

// //               // ===============================
// //               // CREATE PRODUCT IF NOT EXISTS
// //               // ===============================
// //               if (!productMap[productName]) {
// //                 const slug = await generateSlug(productName);

// //                 const categorySlug = slugify(row.category, {
// //                   lower: true,
// //                   strict: true,
// //                 });

// //                 let category = await Category.findOne({
// //                   slug: categorySlug,
// //                 });

// //                 if (!category) {
// //                   category = await Category.create({
// //                     name: row.category,
// //                     slug: categorySlug,
// //                     status: "active",
// //                     level: 0,
// //                   });
// //                 }

// //                 productMap[productName] = {
// //                   name: productName,
// //                   slug,
// //                   title: row.title || productName,
// //                   description: row.description || "",
// //                   category: category._id,
// //                   brand: row.brand || "Generic",
// //                   status: row.status?.toLowerCase() || "draft",
// //                   isFeatured: row.isfeatured === "true",
// //                   variants: [],
// //                   soldInfo: {
// //                     enabled: row.soldEnabled === "true",
// //                     count: Number(row.soldCount) || 0,
// //                   },
// //                   fomo: {
// //                     enabled: row.fomoEnabled === "true",
// //                     type: row.fomoType || "viewing_now",
// //                     viewingNow: Number(row.viewingNow) || 0,
// //                     productLeft: Number(row.productLeft) || 0,
// //                     customMessage: row.customMessage || "",
// //                   },
// //                 };
// //               }

// //               // ===============================
// //               // VARIANT ATTRIBUTES
// //               // ===============================
// //               let variantAttributes = [];

// //               if (row.variantAttributes) {
// //                 variantAttributes = row.variantAttributes
// //                   .split("|")
// //                   .map((pair) => {
// //                     const [key, value] = pair.split(":");
// //                     return {
// //                       key: key?.trim(),
// //                       value: value?.trim(),
// //                     };
// //                   });
// //               }

// //               // ===============================
// //               // PRODUCT ATTRIBUTES
// //               // ===============================
// //               let productAttributes = [];

// //               if (row.productAttributes) {
// //                 productAttributes = row.productAttributes
// //                   .split("|")
// //                   .map((pair) => {
// //                     const [key, value] = pair.split(":");
// //                     return {
// //                       key: key?.trim(),
// //                       value: value?.trim(),
// //                     };
// //                   });
// //               }

// //               // ===============================
// //               // IMAGE UPLOAD FROM URL (UNCHANGED)
// //               // ===============================
// //               let imagesArr = [];

// //               if (row.images) {
// //                 const imageUrls = row.images
// //                   .split(",")
// //                   .map((u) => u.trim())
// //                   .slice(0, 5);

// //                 for (let url of imageUrls) {
// //                   if (!url) continue;

// //                   try {
// //                     if (url.startsWith("data:image")) {
// //                       const uploadResult =
// //                         await cloudinary.uploader.upload(url, {
// //                           resource_type: "image",
// //                         });

// //                       imagesArr.push({
// //                         url: uploadResult.secure_url,
// //                         publicId: uploadResult.public_id,
// //                         altText: productName,
// //                         order: imagesArr.length,
// //                       });
// //                     } else if (url.startsWith("http")) {
// //                       const response = await axios({
// //                         method: "GET",
// //                         url: url,
// //                         responseType: "arraybuffer",
// //                         timeout: 15000,
// //                         headers: {
// //                           "User-Agent": "Mozilla/5.0",
// //                         },
// //                       });

// //                       const base64 = Buffer.from(response.data).toString(
// //                         "base64"
// //                       );
// //                       const mimeType = response.headers["content-type"];
// //                       const dataURI = `data:${mimeType};base64,${base64}`;

// //                       const uploadResult =
// //                         await cloudinary.uploader.upload(dataURI, {
// //                           resource_type: "image",
// //                         });

// //                       imagesArr.push({
// //                         url: uploadResult.secure_url,
// //                         publicId: uploadResult.public_id,
// //                         altText: productName,
// //                         order: imagesArr.length,
// //                       });
// //                     }
// //                   } catch (err) {
// //                     console.log("Image upload failed:", url);
// //                     console.log("ERROR:", err.message);
// //                   }
// //                 }
// //               }

// //               // ===============================
// //               // BUILD VARIANT OBJECT
// //               // ===============================
// //               const variant = {
// //                 sku:
// //                   "SKU-" +
// //                   Math.floor(100000 + Math.random() * 900000),
// //                 barcode: row.barcode || "",
// //                 attributes: variantAttributes,
// //                 weight: Number(row.weight) || 0,
// //                 dimensions: {
// //                   length: Number(row.length) || 0,
// //                   width: Number(row.width) || 0,
// //                   height: Number(row.height) || 0,
// //                 },
// //                 price: {
// //                   base: cleanBasePrice,   // ✅ FIXED
// //                   sale: cleanSalePrice,   // ✅ FIXED
// //                 },
// //                 inventory: {
// //                   quantity: Number(row.quantity) || 0,
// //                   trackInventory: true,
// //                   lowStockThreshold: 5,
// //                 },
// //                 images: imagesArr,
// //                 isActive: true,
// //               };

// //               productMap[productName].variants.push(variant);

// //               if (
// //                 productAttributes.length &&
// //                 !productMap[productName].productAttributes
// //               ) {
// //                 productMap[productName].productAttributes =
// //                   productAttributes;
// //               }
// //             } catch (err) {
// //               failed.push({
// //                 product: row.name || "Unknown",
// //                 error: err.message,
// //               });
// //             }
// //           }

// //           const finalProducts = Object.values(productMap);
// //           let inserted = [];

// //           if (finalProducts.length > 0) {
// //             inserted = await Product.insertMany(finalProducts);
// //           }

// //           fs.unlinkSync(req.file.path);

// //           return res.status(200).json({
// //             success: true,
// //             totalRows: rows.length,
// //             insertedProducts: inserted.length,
// //             failedCount: failed.length,
// //             failed,
// //           });
// //         } catch (err) {
// //           return res.status(500).json({
// //             success: false,
// //             message: "Processing failed",
// //             error: err.message,
// //           });
// //         }
// //       });
// //   } catch (error) {
// //     return res.status(500).json({
// //       success: false,
// //       message: "CSV import failed",
// //       error: error.message,
// //     });
// //   }
// // };

// // const importProductsFromCSV = async (req, res) => {
// //   try {
// //     if (!req.file) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "CSV file is required",
// //       });
// //     }

// //     const rows = [];
// //     const failed = [];
// //     const productMap = {};

// //     // ===============================
// //     // HELPER — upload single image URL
// //     // ===============================
// //     const uploadImageFromUrl = async (url, productName, order) => {
// //       try {
// //         if (!url) return null;

// //         if (url.startsWith("data:image")) {
// //           const result = await cloudinary.uploader.upload(url, {
// //             resource_type: "image",
// //           });
// //           return {
// //             url: result.secure_url,
// //             publicId: result.public_id,
// //             altText: productName,
// //             order,
// //           };
// //         }

// //         if (url.startsWith("http")) {
// //           const response = await axios({
// //             method: "GET",
// //             url,
// //             responseType: "arraybuffer",
// //             timeout: 60000, // ✅ FIX 1 — increased from 15s to 60s
// //             headers: { "User-Agent": "Mozilla/5.0" },
// //           });

// //           const base64 = Buffer.from(response.data).toString("base64");
// //           const mimeType = response.headers["content-type"];
// //           const dataURI = `data:${mimeType};base64,${base64}`;

// //           const result = await cloudinary.uploader.upload(dataURI, {
// //             resource_type: "image",
// //           });

// //           return {
// //             url: result.secure_url,
// //             publicId: result.public_id,
// //             altText: productName,
// //             order,
// //           };
// //         }

// //         return null;
// //       } catch (err) {
// //         console.log(`Image upload failed [${url}]:`, err.message);
// //         return null;
// //       }
// //     };

// //     // ===============================
// //     // HELPER — parallel batch uploader
// //     // ✅ FIX 2 — 5 images at a time instead of sequential
// //     // ===============================
// //     const uploadImagesInBatches = async (urls, productName, batchSize = 5) => {
// //       const results = [];
// //       for (let i = 0; i < urls.length; i += batchSize) {
// //         const batch = urls.slice(i, i + batchSize);
// //         const batchResults = await Promise.all(
// //           batch.map((url, idx) => uploadImageFromUrl(url, productName, i + idx))
// //         );
// //         batchResults.forEach((r) => { if (r) results.push(r); });
// //       }
// //       return results;
// //     };

// //     fs.createReadStream(req.file.path)
// //       .pipe(csv({ mapHeaders: ({ header }) => header.trim() }))
// //       .on("data", (row) => rows.push(row))
// //       .on("end", async () => {
// //         try {

// //           // ===============================
// //           // PASS 1 — parse rows, group by product name (no I/O)
// //           // ===============================
// //           for (let row of rows) {
// //             try {
// //               Object.keys(row).forEach((key) => {
// //                 if (typeof row[key] === "string") row[key] = row[key].trim();
// //               });

// //               if (!row.name || !row.category || !row.basePrice) {
// //                 throw new Error("Missing required fields");
// //               }

// //               const productName = row.name;

// //               const cleanBasePrice = parseFloat(
// //                 row.basePrice?.replace(/[^0-9.]/g, "")
// //               );
// //               const cleanSalePrice = row.salePrice
// //                 ? parseFloat(row.salePrice.replace(/[^0-9.]/g, ""))
// //                 : null;

// //               if (isNaN(cleanBasePrice)) {
// //                 throw new Error("Invalid basePrice format");
// //               }

// //               if (!productMap[productName]) {
// //                 const slug = await generateSlug(productName);

// //                 const categorySlug = slugify(row.category, {
// //                   lower: true,
// //                   strict: true,
// //                 });

// //                 let category = await Category.findOne({ slug: categorySlug });

// //                 if (!category) {
// //                   category = await Category.create({
// //                     name: row.category,
// //                     slug: categorySlug,
// //                     status: "active",
// //                     level: 0,
// //                   });
// //                 }

// //                 productMap[productName] = {
// //                   name: productName,
// //                   slug,
// //                   title: row.title || productName,
// //                   description: row.description || "",
// //                   category: category._id,
// //                   brand: row.brand || "Generic",
// //                   status: row.status?.toLowerCase() || "draft",
// //                   isFeatured: row.isfeatured === "true",
// //                   variants: [],
// //                   soldInfo: {
// //                     enabled: row.soldEnabled === "true",
// //                     count: Number(row.soldCount) || 0,
// //                   },
// //                   fomo: {
// //                     enabled: row.fomoEnabled === "true",
// //                     type: row.fomoType || "viewing_now",
// //                     viewingNow: Number(row.viewingNow) || 0,
// //                     productLeft: Number(row.productLeft) || 0,
// //                     customMessage: row.customMessage || "",
// //                   },
// //                   _variantQueue: [], // temp queue, deleted before DB insert
// //                 };
// //               }

// //               // parse variant attributes
// //               let variantAttributes = [];
// //               if (row.variantAttributes) {
// //                 variantAttributes = row.variantAttributes
// //                   .split("|")
// //                   .map((pair) => {
// //                     const [key, value] = pair.split(":");
// //                     return { key: key?.trim(), value: value?.trim() };
// //                   })
// //                   .filter((a) => a.key && a.value);
// //               }

// //               // parse product attributes
// //               let productAttributes = [];
// //               if (row.productAttributes) {
// //                 productAttributes = row.productAttributes
// //                   .split("|")
// //                   .map((pair) => {
// //                     const [key, value] = pair.split(":");
// //                     return { key: key?.trim(), value: value?.trim() };
// //                   })
// //                   .filter((a) => a.key && a.value);
// //               }

// //               if (
// //                 productAttributes.length &&
// //                 !productMap[productName].productAttributes
// //               ) {
// //                 productMap[productName].productAttributes = productAttributes;
// //               }

// //               // queue image URLs + variant data for parallel upload in pass 2
// //               const imageUrls = row.images
// //                 ? row.images.split(",").map((u) => u.trim()).filter(Boolean).slice(0, 5)
// //                 : [];

// //               productMap[productName]._variantQueue.push({
// //                 imageUrls,
// //                 variantAttributes,
// //                 cleanBasePrice,
// //                 cleanSalePrice,
// //                 row,
// //               });

// //             } catch (err) {
// //               failed.push({ product: row.name || "Unknown", error: err.message });
// //             }
// //           }

// //           // ===============================
// //           // PASS 2 — upload all images in parallel across all products
// //           // ✅ FIX 3 — all products processed simultaneously
// //           // ===============================
// //           await Promise.all(
// //             Object.values(productMap).map(async (product) => {
// //               for (const item of product._variantQueue) {
// //                 const {
// //                   imageUrls,
// //                   variantAttributes,
// //                   cleanBasePrice,
// //                   cleanSalePrice,
// //                   row,
// //                 } = item;

// //                 const imagesArr = await uploadImagesInBatches(imageUrls, product.name);

// //                 const variant = {
// //                   sku: "SKU-" + Math.floor(100000 + Math.random() * 900000),
// //                   barcode: row.barcode || "",
// //                   attributes: variantAttributes,
// //                   weight: Number(row.weight) || 0,
// //                   dimensions: {
// //                     length: Number(row.length) || 0,
// //                     width: Number(row.width) || 0,
// //                     height: Number(row.height) || 0,
// //                   },
// //                   price: {
// //                     base: cleanBasePrice,
// //                     sale: cleanSalePrice,
// //                   },
// //                   inventory: {
// //                     quantity: Number(row.quantity) || 0,
// //                     trackInventory: true,
// //                     lowStockThreshold: 5,
// //                   },
// //                   images: imagesArr,
// //                   isActive: true,
// //                 };

// //                 product.variants.push(variant);
// //               }

// //               // clean up temp field before DB insert
// //               delete product._variantQueue;
// //             })
// //           );

// //           const finalProducts = Object.values(productMap);
// //           let inserted = [];

// //           if (finalProducts.length > 0) {
// //             inserted = await Product.insertMany(finalProducts);
// //           }

// //           fs.unlinkSync(req.file.path);

// //           return res.status(200).json({
// //             success: true,
// //             totalRows: rows.length,
// //             insertedProducts: inserted.length,
// //             failedCount: failed.length,
// //             failed,
// //           });

// //         } catch (err) {
// //           return res.status(500).json({
// //             success: false,
// //             message: "Processing failed",
// //             error: err.message,
// //           });
// //         }
// //       });

// //   } catch (error) {
// //     return res.status(500).json({
// //       success: false,
// //       message: "CSV import failed",
// //       error: error.message,
// //     });
// //   }
// // };




// //Update existing product
// // Update existing product
// // Update existing product
// // const updateProduct = async (req, res) => {
// //   try {
// //     const slug = req.params.slug;

// //     const existingProduct = await Product.findOne({ slug });
// //     if (!existingProduct) {
// //       return res.status(404).json({
// //         success: false,
// //         message: "Product not found"
// //       });
// //     }

// //     const updates = { ...req.body };
// //     delete updates.slug;
// //     delete updates.sku;
// //     delete updates.variants; // safety

// //     const parseIfString = (value, fallback) => {
// //       if (typeof value === "string") {
// //         try {
// //           return JSON.parse(value);
// //         } catch {
// //           return fallback;
// //         }
// //       }
// //       return value;
// //     };

// //     // =====================================================
// //     // ✅ VARIANT UPDATE BY BARCODE
// //     // =====================================================
// //     if (updates.barlicode) {

// //       const barcodeNumber = Number(updates.barcode);
// //       if (isNaN(barcodeNumber)) {
// //         return res.status(400).json({
// //           success: false,
// //           message: "Invalid barcode"
// //         });
// //       }

// //       const variantIndex = existingProduct.variants.findIndex(
// //         v => v.barcode === barcodeNumber
// //       );

// //       if (variantIndex === -1) {
// //         return res.status(404).json({
// //           success: false,
// //           message: "Variant not found for given barcode"
// //         });
// //       }

// //       const existingVariant = existingProduct.variants[variantIndex];
// //       const updateFields = {};

// //       // =========================
// //       // PRICE UPDATE (SAFE)
// //       // =========================
// //       if (updates.price) {
// //         const parsedPrice = parseIfString(updates.price, {});

// //         const base =
// //           parsedPrice.base !== undefined
// //             ? Number(parsedPrice.base)
// //             : existingVariant.price.base;

// //         const sale =
// //           parsedPrice.sale !== undefined
// //             ? parsedPrice.sale != null
// //               ? Number(parsedPrice.sale)
// //               : null
// //             : existingVariant.price.sale;

// //         if (sale != null && sale >= base) {
// //           return res.status(400).json({
// //             success: false,
// //             message: "Sale price must be less than base price"
// //           });
// //         }

// //         if (parsedPrice.base !== undefined) {
// //           updateFields["variants.$.price.base"] = base;
// //         }

// //         if (parsedPrice.sale !== undefined) {
// //           updateFields["variants.$.price.sale"] = sale;
// //         }
// //       }

// //       // =========================
// //       // INVENTORY UPDATE
// //       // =========================
// //       if (updates.inventory) {
// //         const parsedInventory = parseIfString(updates.inventory, {});

// //         if (parsedInventory.quantity !== undefined) {
// //           updateFields["variants.$.inventory.quantity"] =
// //             Number(parsedInventory.quantity);
// //         }

// //         if (parsedInventory.lowStockThreshold !== undefined) {
// //           updateFields["variants.$.inventory.lowStockThreshold"] =
// //             Number(parsedInventory.lowStockThreshold);
// //         }

// //         if (parsedInventory.trackInventory !== undefined) {
// //           updateFields["variants.$.inventory.trackInventory"] =
// //             parsedInventory.trackInventory;
// //         }
// //       }

// //       const updatedProduct = await Product.findOneAndUpdate(
// //         { slug, "variants.barcode": barcodeNumber },
// //         { $set: updateFields },
// //         { new: true }
// //       );

// //       // 🔁 Recalculate totals
// //       const effectivePrices = updatedProduct.variants.map(v =>
// //         v.price.sale != null ? v.price.sale : v.price.base
// //       );

// //       updatedProduct.priceRange = {
// //         min: Math.min(...effectivePrices),
// //         max: Math.max(...effectivePrices)
// //       };

// //       updatedProduct.totalStock =
// //         updatedProduct.variants.reduce(
// //           (sum, v) => sum + (v.inventory.quantity || 0),
// //           0
// //         );

// //       await updatedProduct.save();

// //       return res.status(200).json({
// //         success: true,
// //         message: "Variant updated successfully",
// //         product: updatedProduct
// //       });
// //     }

// //     // =====================================================
// //     // PRODUCT FIELD UPDATE
// //     // =====================================================

// //     if (updates.name && updates.name !== existingProduct.name) {
// //       updates.slug = await generateSlug(
// //         updates.name,
// //         existingProduct._id
// //       );
// //     }

// //     if (updates.soldInfo) {
// //       const parsed = parseIfString(updates.soldInfo, {});
// //       updates.soldInfo = {
// //         ...existingProduct.soldInfo.toObject(),
// //         ...parsed,
// //         enabled: parsed.enabled === true || parsed.enabled === "true",
// //         count: Number(parsed.count ?? 0)
// //       };
// //     }

// //     if (updates.fomo) {
// //       const parsed = parseIfString(updates.fomo, {});
// //       updates.fomo = {
// //         ...existingProduct.fomo.toObject(),
// //         ...parsed,
// //         enabled: parsed.enabled === true || parsed.enabled === "true",
// //         viewingNow: Number(parsed.viewingNow ?? 0),
// //         productLeft: Number(parsed.productLeft ?? 0),
// //         type: ["viewing_now", "product_left", "custom"].includes(parsed.type)
// //           ? parsed.type
// //           : existingProduct.fomo.type
// //       };
// //     }

// //     if (updates.shipping) {
// //       const parsed = parseIfString(updates.shipping, {});
// //       updates.shipping = {
// //         ...existingProduct.shipping.toObject(),
// //         ...parsed,
// //         weight: Number(parsed.weight ?? 0),
// //         dimensions: {
// //           length: Number(parsed.dimensions?.length ?? 0),
// //           width: Number(parsed.dimensions?.width ?? 0),
// //           height: Number(parsed.dimensions?.height ?? 0)
// //         }
// //       };
// //     }

// //     if (updates.attributes) {
// //       const parsed = parseIfString(updates.attributes, []);
// //       updates.attributes = Array.isArray(parsed)
// //         ? parsed.map(a => ({ key: a.key, value: a.value }))
// //         : [];
// //     }

// //     const updatedProduct = await Product.findByIdAndUpdate(
// //       existingProduct._id,
// //       { $set: updates },
// //       { new: true, runValidators: true }
// //     );

// //     return res.status(200).json({
// //       success: true,
// //       message: "Product updated successfully",
// //       product: updatedProduct
// //     });

// //   } catch (error) {
// //     console.error("Update product error:", error);
// //     return res.status(500).json({
// //       success: false,
// //       message: "Error updating product",
// //       error: error.message
// //     });
// //   }
// // };
// // const updateProduct = async (req, res) => {
// //   try {

// //     const slug = req.params.slug;

// //     const existingProduct = await Product.findOne({ slug });

// //     if (!existingProduct) {
// //       return res.status(404).json({
// //         success: false,
// //         message: "Product not found"
// //       });
// //     }

// //     const updates = { ...req.body };

// //     delete updates.slug;
// //     delete updates.sku;
// //     delete updates.variants;

// //     const parseIfString = (value, fallback) => {
// //       if (typeof value === "string") {
// //         try {
// //           return JSON.parse(value);
// //         } catch {
// //           return fallback;
// //         }
// //       }
// //       return value;
// //     };

// //     // =====================================================
// //     // ✅ VARIANT UPDATE BY BARCODE
// //     // =====================================================

// //     if (updates.barcode) {

// //       const barcodeNumber = Number(updates.barcode);

// //       if (isNaN(barcodeNumber)) {
// //         return res.status(400).json({
// //           success: false,
// //           message: "Invalid barcode"
// //         });
// //       }

// //       const variantIndex = existingProduct.variants.findIndex(
// //         v => v.barcode === barcodeNumber
// //       );

// //       if (variantIndex === -1) {
// //         return res.status(404).json({
// //           success: false,
// //           message: "No product found with this barcode"
// //         });
// //       }

// //       const existingVariant = existingProduct.variants[variantIndex];

// //       const updateFields = {};

// //       // =========================
// //       // PRICE UPDATE
// //       // =========================

// //       if (updates.price) {

// //         const parsedPrice = parseIfString(updates.price, {});

// //         const base =
// //           parsedPrice.base !== undefined
// //             ? Number(parsedPrice.base)
// //             : existingVariant.price.base;

// //         const sale =
// //           parsedPrice.sale !== undefined
// //             ? parsedPrice.sale != null
// //               ? Number(parsedPrice.sale)
// //               : null
// //             : existingVariant.price.sale;

// //         if (sale != null && sale >= base) {
// //           return res.status(400).json({
// //             success: false,
// //             message: "Sale price must be less than base price"
// //           });
// //         }

// //         if (parsedPrice.base !== undefined) {
// //           updateFields["variants.$.price.base"] = base;
// //         }

// //         if (parsedPrice.sale !== undefined) {
// //           updateFields["variants.$.price.sale"] = sale;
// //         }
// //       }

// //       // =========================
// //       // INVENTORY UPDATE
// //       // =========================

// //       if (updates.inventory) {

// //         const parsedInventory = parseIfString(updates.inventory, {});

// //         if (parsedInventory.quantity !== undefined) {
// //           updateFields["variants.$.inventory.quantity"] =
// //             Number(parsedInventory.quantity);
// //         }

// //         if (parsedInventory.lowStockThreshold !== undefined) {
// //           updateFields["variants.$.inventory.lowStockThreshold"] =
// //             Number(parsedInventory.lowStockThreshold);
// //         }

// //         if (parsedInventory.trackInventory !== undefined) {
// //           updateFields["variants.$.inventory.trackInventory"] =
// //             parsedInventory.trackInventory;
// //         }
// //       }

// //       // =========================
// //       // ✅ IMAGES UPDATE (FIXED)
// //       // =========================

// //       if (req.files && req.files.length > 0) {

// //         // delete old images
// //         if (existingVariant.images && existingVariant.images.length > 0) {

// //           for (const img of existingVariant.images) {

// //             if (img.publicId) {
// //               await deleteFromCloudinary(img.publicId);
// //             }

// //           }

// //         }

// //         const uploadedImages = [];

// //         for (let i = 0; i < req.files.length; i++) {

// //           const file = req.files[i];

// //           // ensure buffer exists
// //           if (!file.buffer) {
// //             continue;
// //           }

// //           const uploadResult = await uploadToCloudinary(
// //             file.buffer,
// //             "products"
// //           );

// //           uploadedImages.push({
// //             url: uploadResult.url,
// //             publicId: uploadResult.publicId,
// //             altText: existingProduct.name,
// //             order: i
// //           });

// //         }

// //         updateFields["variants.$.images"] = uploadedImages;

// //       }

// //       const updatedProduct = await Product.findOneAndUpdate(
// //         { slug, "variants.barcode": barcodeNumber },
// //         { $set: updateFields },
// //         { new: true }
// //       );

// //       // 🔁 Recalculate totals

// //       const effectivePrices = updatedProduct.variants.map(v =>
// //         v.price.sale != null ? v.price.sale : v.price.base
// //       );

// //       updatedProduct.priceRange = {
// //         min: Math.min(...effectivePrices),
// //         max: Math.max(...effectivePrices)
// //       };

// //       updatedProduct.totalStock =
// //         updatedProduct.variants.reduce(
// //           (sum, v) => sum + (v.inventory.quantity || 0),
// //           0
// //         );

// //       await updatedProduct.save();

// //       return res.status(200).json({
// //         success: true,
// //         message: "Variant updated successfully",
// //         product: updatedProduct
// //       });

// //     }

// //     // =====================================================
// //     // PRODUCT FIELD UPDATE
// //     // =====================================================

// //     if (updates.name && updates.name !== existingProduct.name) {

// //       updates.slug = await generateSlug(
// //         updates.name,
// //         existingProduct._id
// //       );

// //     }

// //     if (updates.soldInfo) {

// //       const parsed = parseIfString(updates.soldInfo, {});

// //       updates.soldInfo = {
// //         ...existingProduct.soldInfo.toObject(),
// //         ...parsed,
// //         enabled: parsed.enabled === true || parsed.enabled === "true",
// //         count: Number(parsed.count ?? 0)
// //       };

// //     }

// //     if (updates.fomo) {

// //       const parsed = parseIfString(updates.fomo, {});

// //       updates.fomo = {
// //         ...existingProduct.fomo.toObject(),
// //         ...parsed,
// //         enabled: parsed.enabled === true || parsed.enabled === "true",
// //         viewingNow: Number(parsed.viewingNow ?? 0),
// //         productLeft: Number(parsed.productLeft ?? 0),
// //         type: ["viewing_now", "product_left", "custom"].includes(parsed.type)
// //           ? parsed.type
// //           : existingProduct.fomo.type
// //       };

// //     }

// //     if (updates.shipping) {

// //       const parsed = parseIfString(updates.shipping, {});

// //       updates.shipping = {
// //         ...existingProduct.shipping.toObject(),
// //         ...parsed,
// //         weight: Number(parsed.weight ?? 0),
// //         dimensions: {
// //           length: Number(parsed.dimensions?.length ?? 0),
// //           width: Number(parsed.dimensions?.width ?? 0),
// //           height: Number(parsed.dimensions?.height ?? 0)
// //         }
// //       };

// //     }

// //     if (updates.attributes) {

// //       const parsed = parseIfString(updates.attributes, []);

// //       updates.attributes = Array.isArray(parsed)
// //         ? parsed.map(a => ({ key: a.key, value: a.value }))
// //         : [];

// //     }

// //     const updatedProduct = await Product.findByIdAndUpdate(
// //       existingProduct._id,
// //       { $set: updates },
// //       { new: true, runValidators: true }
// //     );

// //     return res.status(200).json({
// //       success: true,
// //       message: "Product updated successfully",
// //       product: updatedProduct
// //     });

// //   } catch (error) {

// //     console.error("Update product error:", error);

// //     return res.status(500).json({
// //       success: false,
// //       message: "Error updating product",
// //       error: error.message
// //     });

// //   }
// // };

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
//       // ✅ IMAGES UPDATE (PATCHED)
//       // Handles 3 cases:
//       //   A) New file uploads → delete old Cloudinary images, upload new ones
//       //   B) Existing images reordered / ★ set as main → update order without
//       //      touching Cloudinary (frontend sorts isMain=true to index 0)
//       //   C) Both channels present → new files take priority (existing ignored)
//       // =========================

//       const hasNewFiles = req.files && req.files.length > 0;
//       const existingImagesRaw = updates.existingImages;

//       if (hasNewFiles) {

//         // Delete old Cloudinary images
//         if (existingVariant.images && existingVariant.images.length > 0) {
//           for (const img of existingVariant.images) {
//             if (img.publicId) {
//               await deleteFromCloudinary(img.publicId);
//             }
//           }
//         }

//         // Upload new files
//         const uploadedImages = [];

//         for (let i = 0; i < req.files.length; i++) {
//           const file = req.files[i];

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

//       } else if (existingImagesRaw) {

//         // No new files — admin reordered images or clicked ★ to set main.
//         // Frontend already sorted isMain=true to index 0 before sending,
//         // so index 0 here is the new main/thumbnail image.
//         // We update image order without touching Cloudinary at all.
//         try {
//           const reordered = parseIfString(existingImagesRaw, null);

//           if (Array.isArray(reordered) && reordered.length > 0) {
//             updateFields["variants.$.images"] = reordered.map((img, i) => ({
//               url:      img.url      || "",
//               publicId: img.publicId || "",
//               altText:  img.altText  || existingProduct.name,
//               order:    i
//             }));
//           }
//         } catch (e) {
//           // JSON parse error — leave images unchanged, don't crash
//           console.warn("existingImages parse error:", e.message);
//         }
//       }

//       // =========================
//       // ✅ IS ACTIVE UPDATE (NEW — was completely missing before)
//       // This is why toggling isActive in the variant modal never saved to DB.
//       // Frontend sends: fd.append("isActive", String(true/false))
//       // =========================

//       if (updates.isActive !== undefined) {
//         updateFields["variants.$.isActive"] =
//           updates.isActive === true || updates.isActive === "true";
//       }

//       // =========================
//       // ATTRIBUTES UPDATE
//       // =========================

//       if (updates.attributes) {
//         const parsedAttributes = parseIfString(updates.attributes, []);

//         if (Array.isArray(parsedAttributes)) {
//           updateFields["variants.$.attributes"] = parsedAttributes.map(a => ({
//             key: a.key,
//             value: a.value
//           }));
//         }
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
// // Soft delete (archive)
// // Soft delete (archive)
// const deleteProduct = async (req, res) => {
//   try {
//     const { slug } = req.params;

//     const product = await Product.findOneAndUpdate(
//       { slug, status: { $ne: "archived" } },
//       { 
//         $set: { 
//           status: "archived",
//           // archivedAt: new Date()
//         } 
//       },
//       { new: true }
//     );

//     if (!product) {
//       return res.status(404).json({
//         success: false,
//         message: "Product not found or already archived"
//       });
//     }

//     return res.status(200).json({
//       success: true,
//       message: "Product archived successfully",
//       product
//     });

//   } catch (error) {
//     console.error("Archive product error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error archiving product",
//       error: error.message
//     });
//   }
// };

// // Bulk delete (archive multiple)
// // Bulk archive products
// const bulkDelete = async (req, res) => {
//   try {
//     let { slugs } = req.body;

//     if (!Array.isArray(slugs) || slugs.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "slugs array is required"
//       });
//     }

//     // Sanitize slugs (remove invalid values)
//     slugs = slugs
//       .filter(slug => typeof slug === "string" && slug.trim() !== "")
//       .map(slug => slug.trim());

//     if (slugs.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "No valid slugs provided"
//       });
//     }

//     // Optional: Protect from huge requests
//     if (slugs.length > 500) {
//       return res.status(400).json({
//         success: false,
//         message: "Maximum 500 products allowed per request"
//       });
//     }

//     const result = await Product.updateMany(
//       {
//         slug: { $in: slugs },
//         status: { $ne: "archived" }
//       },
//       {
//         $set: {
//           status: "archived",
//           archivedAt: new Date()
//         }
//       }
//     );

//     return res.status(200).json({
//       success: true,
//       message: "Bulk archive completed",
//       requested: slugs.length,
//       archived: result.modifiedCount,
//       skipped: slugs.length - result.modifiedCount
//     });

//   } catch (error) {
//     console.error("Bulk archive error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error archiving products",
//       error: error.message
//     });
//   }
// };

// // Restore archived product
// // Restore archived product
// const restoreProduct = async (req, res) => {
//   try {
//     const { slug } = req.params;

//     const product = await Product.findOneAndUpdate(
//       { slug, status: "archived" },
//       {
//         $set: { status: "active" }, // or your default restore status
//         $unset: { archivedAt: "" }
//       },
//       { new: true }
//     );

//     if (!product) {
//       return res.status(404).json({
//         success: false,
//         message: "Archived product not found"
//       });
//     }

//     return res.status(200).json({
//       success: true,
//       message: "Product restored successfully",
//       product
//     });

//   } catch (error) {
//     console.error("Restore product error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error restoring product",
//       error: error.message
//     });
//   }
// };


// // Bulk restore archived products
// // Bulk restore archived products
// const bulkRestore = async (req, res) => {
//   try {
//     let { slugs } = req.body;

//     if (!Array.isArray(slugs) || slugs.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "slugs array is required"
//       });
//     }

//     // Sanitize slugs
//     slugs = slugs
//       .filter(slug => typeof slug === "string" && slug.trim() !== "")
//       .map(slug => slug.trim());

//     if (slugs.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "No valid slugs provided"
//       });
//     }

//     // Optional protection
//     if (slugs.length > 500) {
//       return res.status(400).json({
//         success: false,
//         message: "Maximum 500 products allowed per request"
//       });
//     }

//     const result = await Product.updateMany(
//       {
//         slug: { $in: slugs },
//         status: "archived"
//       },
//       {
//         $set: { status: "active" }, // or your default restore status
//         $unset: { archivedAt: "" }
//       }
//     );

//     return res.status(200).json({
//       success: true,
//       message: "Bulk restore completed",
//       requested: slugs.length,
//       restored: result.modifiedCount,
//       skipped: slugs.length - result.modifiedCount
//     });

//   } catch (error) {
//     console.error("Bulk restore error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error restoring products",
//       error: error.message
//     });
//   }
// };




// // Get low stock products
// // Get low stock products
// const getLowStockProducts = async (req, res) => {
//   try {
//     let { page = 1, limit = 20 } = req.query;

//     const pageNumber = Math.max(1, Number(page));
//     const limitNumber = Math.min(100, Number(limit));
//     const skip = (pageNumber - 1) * limitNumber;

//     const query = {
//       status: "active",
//       $expr: {
//         $anyElementTrue: {
//           $map: {
//             input: "$variants",
//             as: "variant",
//             in: {
//               $and: [
//                 { $eq: ["$$variant.inventory.trackInventory", true] },
//                 { $gt: ["$$variant.inventory.quantity", 0] },
//                 {
//                   $lte: [
//                     "$$variant.inventory.quantity",
//                     "$$variant.inventory.lowStockThreshold"
//                   ]
//                 }
//               ]
//             }
//           }
//         }
//       }
//     };

//     const [products, total] = await Promise.all([
//       Product.find(query)
//         .sort({ "variants.inventory.quantity": 1 })
//         .skip(skip)
//         .limit(limitNumber),

//       Product.countDocuments(query)
//     ]);

//     return res.status(200).json({
//       success: true,
//       total,
//       page: pageNumber,
//       limit: limitNumber,
//       count: products.length,
//       products
//     });

//   } catch (error) {
//     console.error("Low stock products error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error fetching low stock products",
//       error: error.message
//     });
//   }
// };

// //get all the products
// // Get all active products (paginated)
// const getAllActiveProducts = async (req, res) => {
//   try {
//     let { page = 1, limit = 20 } = req.query;

//     const pageNumber = Math.max(1, Number(page));
//     const limitNumber = Math.min(100, Number(limit));
//     const skip = (pageNumber - 1) * limitNumber;

//     // const query = { status: "active" };

//     const [products, total] = await Promise.all([
//       Product.find(query)
//         .populate("category", "name")
//         .sort({ createdAt: -1 })
//         .skip(skip)
//         .limit(limitNumber)
//         .lean(),

//       // Product.countDocuments(query)
//     ]);

//     return res.status(200).json({
//       success: true,
//       total,
//       page: pageNumber,
//       limit: limitNumber,
//       count: products.length,
//       products
//     });

//   } catch (error) {
//     console.error("Get all products error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error fetching products",
//       error: error.message
//     });
//   }
// };


// // get all ADMIN PRODUCTS (including draft and archived, paginated)
// // const getAdminProducts = async (req, res) => {
// //   try {
// //     // let { page = 1, limit = 20 } = req.query; 

// //     // const pageNumber = Math.max(1, Number(page));
// //     // const limitNumber = Math.min(100, Number(limit));
// //     // const skip = (pageNumber - 1) * limitNumber;

// //     // const query = { status: { $in: ["draft", "active", "archived"] } };

// //     // const [products, total] = await Promise.all([
// //     //   Product.find()
// //     //     .select("name slug price images category status createdAt")
// //     //     .populate("category", "name")
// //     //     .sort({ createdAt: -1 })
// //     //     .skip(skip)
// //     //     .limit(limitNumber)
// //     //     .lean(),

// //     //   Product.countDocuments()
// //     // ]);

// //     const products = await Product.find()
// //       // .lean();

// //     return res.status(200).json({
// //       success: true,
// //       products
// //     });

// //   } catch (error) {
// //     console.error("Get admin products error:", error);
// //     return res.status(500).json({
// //       success: false,
// //       message: "Error fetching admin products",
// //       error: error.message
// //     });
// //   }
// // };

// // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

// //get single product by slug
// // Get single product by slug
// const getProductBySlug = async (req, res) => {
//   try {
//     const slug = req.params.slug?.trim();

//     if (!slug) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid product slug"
//       });
//     }

//     const product = await Product.findOne({
//       slug,
//       status: "active"
//     })
//       .populate("category", "name")
//       .lean();

//     if (!product) {
//       return res.status(404).json({
//         success: false,
//         message: "Product not found"
//       });
//     }

//     return res.status(200).json({
//       success: true,
//       product
//     });

//   } catch (error) {
//     console.error("Get product by slug error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error fetching product",
//       error: error.message
//     });
//   }
// };

// //get products with only archived status
// // Get archived products (paginated)
// const getArchivedProducts = async (req, res) => {
//   try {
//     let { page = 1, limit = 20 } = req.query;

//     const pageNumber = Math.max(1, Number(page));
//     const limitNumber = Math.min(100, Number(limit));
//     const skip = (pageNumber - 1) * limitNumber;

//     const query = { status: "archived" };

//     const [products, total] = await Promise.all([
//       Product.find(query)
//         .populate("category", "name")
//         .sort({ createdAt: -1 })
//         .skip(skip)
//         .limit(limitNumber)
//         .lean(),

//       Product.countDocuments(query)
//     ]);

//     return res.status(200).json({
//       success: true,
//       total,
//       page: pageNumber,
//       limit: limitNumber,
//       count: products.length,
//       products
//     });

//   } catch (error) {
//     console.error("Get archived products error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error fetching archived products",
//       error: error.message
//     });
//   }
// };


// //get products with only draft status
// // Get draft products (paginated)
// const getDraftProducts = async (req, res) => {
//   try {
//     let { page = 1, limit = 20 } = req.query;

//     const pageNumber = Math.max(1, Number(page));
//     const limitNumber = Math.min(100, Number(limit));
//     const skip = (pageNumber - 1) * limitNumber;

//     const query = { status: "draft" };

//     const [products, total] = await Promise.all([
//       Product.find(query)
//         .populate("category", "name")
//         .sort({ createdAt: -1 })
//         .skip(skip)
//         .limit(limitNumber)
//         .lean(),

//       Product.countDocuments(query)
//     ]);

//     return res.status(200).json({
//       success: true,
//       total,
//       page: pageNumber,
//       limit: limitNumber,
//       count: products.length,
//       products
//     });

//   } catch (error) {
//     console.error("Get draft products error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error fetching draft products",
//       error: error.message
//     });
//   }
// };


// // Hard delete (permanently delete archived product)
// const hardDeleteProduct = async (req, res) => {
//   try {
//     const { slug } = req.params;

//     if (!slug) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid product slug"
//       });
//     }

//     const product = await Product.findOne({ slug }).lean();

//     if (!product) {
//       return res.status(404).json({
//         success: false,
//         message: "Product not found"
//       });
//     }

//     if (product.status !== "archived") {
//       return res.status(400).json({
//         success: false,
//         message: "Only archived products can be permanently deleted"
//       });
//     }

//     const publicIds = [];

//     if (Array.isArray(product.images)) {
//       product.images.forEach(img => {
//         if (img.publicId) publicIds.push(img.publicId);
//       });
//     }

//     if (Array.isArray(product.variants)) {
//       product.variants.forEach(variant => {
//         if (Array.isArray(variant.images)) {
//           variant.images.forEach(img => {
//             if (img.publicId) publicIds.push(img.publicId);
//           });
//         }
//       });
//     }

//     const uniquePublicIds = [...new Set(publicIds)];

//     await Promise.all(
//       uniquePublicIds.map(async (id) => {
//         try {
//           await deleteFromCloudinary(id);
//         } catch (err) {
//           console.error("Cloudinary delete failed:", id);
//         }
//       })
//     );

//     await Product.deleteOne({ _id: product._id });

//     return res.status(200).json({
//       success: true,
//       message: "Product permanently deleted"
//     });

//   } catch (error) {
//     console.error("Hard delete product error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error permanently deleting product",
//       error: error.message
//     });
//   }
// };
// // Bulk hard delete (permanently delete multiple archived products)
// // Bulk hard delete (permanently delete multiple archived products)
// const bulkHardDelete = async (req, res) => {
//   try {
//     const { slugs } = req.body;

//     if (!Array.isArray(slugs) || slugs.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: "slugs array is required"
//       });
//     }

//     // ==========================================
//     // 1️⃣ Fetch only archived products (lean)
//     // ==========================================
//     const products = await Product.find({
//       slug: { $in: slugs },
//       status: "archived"
//     }).lean();

//     if (products.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "No archived products found to delete"
//       });
//     }

//     const productIds = products.map(p => p._id);

//     // ==========================================
//     // 2️⃣ Collect ALL publicIds first
//     // ==========================================
//     const publicIds = [];

//     for (const product of products) {
//       if (Array.isArray(product.images)) {
//         for (const img of product.images) {
//           if (img.publicId) {
//             publicIds.push(img.publicId);
//           }
//         }
//       }

//       if (Array.isArray(product.variants)) {
//         for (const variant of product.variants) {
//           if (Array.isArray(variant.images)) {
//             for (const img of variant.images) {
//               if (img.publicId) {
//                 publicIds.push(img.publicId);
//               }
//             }
//           }
//         }
//       }
//     }

//     // ==========================================
//     // 3️⃣ Delete images in parallel (SAFE)
//     // ==========================================
//     if (publicIds.length > 0) {
//       await Promise.allSettled(
//         publicIds.map(id => deleteFromCloudinary(id))
//       );
//     }

//     // ==========================================
//     // 4️⃣ Delete from DB
//     // ==========================================
//     const deleteResult = await Product.deleteMany({
//       _id: { $in: productIds }
//     });

//     return res.status(200).json({
//       success: true,
//       message: "Products permanently deleted",
//       requested: slugs.length,
//       deletedCount: deleteResult.deletedCount,
//       skipped: slugs.length - deleteResult.deletedCount
//     });

//   } catch (error) {
//     console.error("Bulk hard delete error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error permanently deleting products",
//       error: error.message
//     });
//   }
// };

// //get All prodcuts or admin with limits and q 

// const getAllProductsAdmin = async (req, res) => {
//   try {
//     let { page = 1, limit = 20 } = req.query;

//     page = Number(page);
//     // limit = Number(limit);
//     limit = Math.min(100, Math.max(1, Number(limit))); // max 10

//     const skip = (page - 1) * limit;

//     let query = {};

   

//     const products = await Product.find()
//       .sort({ createdAt: -1 }) // latest first
//       .skip(skip)
//       .limit(limit);

//     const totalProducts = await Product.countDocuments();

//     return res.status(200).json({
//       success: true,
//        totalProducts,
//       totalPages: Math.ceil(totalProducts / limit),
//       currentPage: page,
//       products
//     });

//   } catch (error) {
//     console.error("Get all products error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error fetching products",
//       error: error.message
//     });
//   }
// };

// //get all active + draft + archived products (paginated) for admin view
// const getAdminProducts = async (req, res) => {
//   try {
//         const products = await Product.find()
//         console.log(products)
//         return res.status(200).json({
//           success: true,
//           products
//         });
//   } catch (error) {
//     console.error("Get admin products error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error fetching admin products",
//       error: error.message
//     });
//   }
// }







// //Add variant to existing product
// // Add variant to existing product
// // const addVariant = async (req, res) => {
// //   try {

// //     const { slug } = req.params;

// //     const product = await Product.findOne({ slug });

// //     if (!product) {
// //       return res.status(404).json({
// //         success: false,
// //         message: "Product not found"
// //       });
// //     }

// //     // =========================
// //     // Parse body safely
// //     // =========================
// //     let variant = req.body;

// //     if (typeof variant === "string") {
// //       variant = JSON.parse(variant);
// //     }

// //     // =========================
// //     // 🔒 BARCODE VALIDATION
// //     // =========================
// //     if (!variant.barcode) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "Barcode is required"
// //       });
// //     }

// //     const barcodeNumber = Number(variant.barcode);

// //     if (isNaN(barcodeNumber)) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "Barcode must be a valid number"
// //       });
// //     }

// //     // 🔒 Global duplicate check
// //     const barcodeExists = await Product.exists({
// //       "variants.barcode": barcodeNumber
// //     });

// //     if (barcodeExists) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "Variant with this barcode already exists"
// //       });
// //     }

// //     // =========================
// //     // 🔒 PRICE VALIDATION
// //     // =========================
// //     if (!variant.price?.base) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "Base price is required"
// //       });
// //     }

// //     const basePrice = Number(variant.price.base);

// //     const salePrice =
// //       variant.price.sale != null
// //         ? Number(variant.price.sale)
// //         : null;

// //     if (salePrice != null && salePrice >= basePrice) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "Sale price must be less than base price"
// //       });
// //     }

// //     // =========================
// //     // 🔥 AUTO GENERATE SKU
// //     // =========================
// //     const skuVal = await generateSku();

// //     // =========================
// //     // 📸 IMAGE UPLOAD
// //     // =========================
// //     let uploadedImages = [];

// //     if (req.files && req.files.length > 0) {

// //       for (let i = 0; i < req.files.length; i++) {

// //         const file = req.files[i];

// //         if (!file.buffer) continue;

// //         const uploadResult = await uploadToCloudinary(
// //           file.buffer,
// //           "products"
// //         );

// //         uploadedImages.push({
// //           url: uploadResult.url,
// //           publicId: uploadResult.publicId,
// //           altText: product.name,
// //           order: i
// //         });

// //       }

// //     }

// //     // =========================
// //     // BUILD NEW VARIANT
// //     // =========================
// //     const newVariant = {
// //       sku: skuVal,
// //       barcode: barcodeNumber,

// //       attributes: Array.isArray(variant.attributes)
// //         ? variant.attributes.map(a => ({
// //             key: a.key,
// //             value: a.value
// //           }))
// //         : [],

// //       price: {
// //         base: basePrice,
// //         sale: salePrice
// //       },

// //       inventory: {
// //         quantity: Number(variant.inventory?.quantity || 0),
// //         lowStockThreshold: Number(
// //           variant.inventory?.lowStockThreshold || 5
// //         ),
// //         trackInventory:
// //           variant.inventory?.trackInventory ?? true
// //       },

// //       images: uploadedImages,

// //       isActive: variant.isActive !== false
// //     };

// //     product.variants.push(newVariant);

// //     // =========================
// //     // 🔁 RECALCULATE TOTALS
// //     // =========================
// //     const effectivePrices = product.variants.map(v =>
// //       v.price.sale != null ? v.price.sale : v.price.base
// //     );

// //     product.priceRange = {
// //       min: Math.min(...effectivePrices),
// //       max: Math.max(...effectivePrices)
// //     };

// //     product.totalStock = product.variants.reduce(
// //       (sum, v) => sum + (v.inventory.quantity || 0),
// //       0
// //     );

// //     await product.save();

// //     return res.status(200).json({
// //       success: true,
// //       message: "Variant added successfully",
// //       product
// //     });

// //   } catch (error) {

// //     console.error("Add variant error:", error);

// //     return res.status(500).json({
// //       success: false,
// //       message: "Error adding variant",
// //       error: error.message
// //     });

// //   }
// // };

// const addVariant = async (req, res) => {
//   try {
//     const { slug } = req.params;

//     const product = await Product.findOne({ slug });

//     if (!product) {
//       return res.status(404).json({
//         success: false,
//         message: "Product not found"
//       });
//     }

//     // =========================
//     // Parse body safely - SAME as updateProduct
//     // =========================
//     let variant = { ...req.body };

//     // Helper function to parse JSON strings (same as updateProduct)
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

//     // Parse all potential JSON fields (same as updateProduct)
//     if (variant.price) {
//       variant.price = parseIfString(variant.price, {});
//     }

//     if (variant.attributes) {
//       variant.attributes = parseIfString(variant.attributes, []);
//     }

//     if (variant.inventory) {
//       variant.inventory = parseIfString(variant.inventory, {});
//     }

//     // Log parsed data for debugging
//     console.log("Parsed variant data:", JSON.stringify(variant, null, 2));

//     // =========================
//     // 🔒 BARCODE VALIDATION
//     // =========================
//     if (!variant.barcode) {
//       return res.status(400).json({
//         success: false,
//         message: "Barcode is required"
//       });
//     }

//     const barcodeNumber = Number(variant.barcode);

//     if (isNaN(barcodeNumber)) {
//       return res.status(400).json({
//         success: false,
//         message: "Barcode must be a valid number"
//       });
//     }

//     // 🔒 Global duplicate check
//     const barcodeExists = await Product.exists({
//       "variants.barcode": barcodeNumber
//     });

//     if (barcodeExists) {
//       return res.status(400).json({
//         success: false,
//         message: "Variant with this barcode already exists"
//       });
//     }

//     // =========================
//     // 🔒 PRICE VALIDATION - Now works because price is parsed
//     // =========================
//     if (!variant.price?.base) {
//       return res.status(400).json({
//         success: false,
//         message: "Base price is required"
//       });
//     }

//     const basePrice = Number(variant.price.base);
//     if (isNaN(basePrice) || basePrice <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Base price must be a valid number greater than 0"
//       });
//     }

//     const salePrice = variant.price.sale != null
//       ? Number(variant.price.sale)
//       : null;

//     if (salePrice !== null && (isNaN(salePrice) || salePrice >= basePrice)) {
//       return res.status(400).json({
//         success: false,
//         message: "Sale price must be a valid number less than base price"
//       });
//     }

//     // =========================
//     // 🔥 AUTO GENERATE SKU
//     // =========================
//     const skuVal = await generateSku();

//     // =========================
//     // 📸 IMAGE UPLOAD
//     // =========================
//     let uploadedImages = [];

//     if (req.files && req.files.length > 0) {
//       for (let i = 0; i < req.files.length; i++) {
//         const file = req.files[i];

//         if (!file.buffer) continue;

//         const uploadResult = await uploadToCloudinary(
//           file.buffer,
//           "products"
//         );

//         uploadedImages.push({
//           url: uploadResult.url,
//           publicId: uploadResult.publicId,
//           altText: product.name,
//           order: i
//         });
//       }
//     }

//     // =========================
//     // BUILD NEW VARIANT
//     // =========================
//     const newVariant = {
//       sku: skuVal,
//       barcode: barcodeNumber,

//       attributes: Array.isArray(variant.attributes)
//         ? variant.attributes
//             .filter(a => a.key && a.value)
//             .map(a => ({
//               key: a.key,
//               value: a.value
//             }))
//         : [],

//       price: {
//         base: basePrice,
//         sale: salePrice
//       },

//       inventory: {
//         quantity: Number(variant.inventory?.quantity || 0),
//         lowStockThreshold: Number(variant.inventory?.lowStockThreshold || 5),
//         trackInventory: variant.inventory?.trackInventory !== false
//       },

//       images: uploadedImages,

//       isActive: variant.isActive !== false
//     };

//     product.variants.push(newVariant);

//     // =========================
//     // 🔁 RECALCULATE TOTALS
//     // =========================
//     const effectivePrices = product.variants.map(v =>
//       v.price.sale != null ? v.price.sale : v.price.base
//     );

//     product.priceRange = {
//       min: Math.min(...effectivePrices),
//       max: Math.max(...effectivePrices)
//     };

//     product.totalStock = product.variants.reduce(
//       (sum, v) => sum + (v.inventory.quantity || 0),
//       0
//     );

//     await product.save();

//     return res.status(200).json({
//       success: true,
//       message: "Variant added successfully",
//       product
//     });

//   } catch (error) {
//     console.error("Add variant error:", error);

//     return res.status(500).json({
//       success: false,
//       message: "Error adding variant",
//       error: error.message
//     });
//   }
// };
// //delete variant from existing product
// //Add variant to existing product
// // Add variant to existing product
// // Delete variant from existing product
// const deleteVariant = async (req, res) => {
//   try {
//     const { slug } = req.params;
//     const { barcode } = req.body;

//     if (!barcode) {
//       return res.status(400).json({
//         success: false,
//         message: "Barcode is required"
//       });
//     }

//     const barcodeNumber = Number(barcode);

//     if (isNaN(barcodeNumber)) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid barcode"
//       });
//     }

//     const product = await Product.findOne({ slug });

//     if (!product) {
//       return res.status(404).json({
//         success: false,
//         message: "Product not found"
//       });
//     }

//     // 🔒 Check variant exists
//     const variantExists = product.variants.some(
//       v => v.barcode === barcodeNumber
//     );

//     if (!variantExists) {
//       return res.status(404).json({
//         success: false,
//         message: "Variant not found"
//       });
//     }

//     // 🔒 Prevent deleting last variant (recommended)
//     if (product.variants.length === 1) {
//       return res.status(400).json({
//         success: false,
//         message: "Cannot delete last variant of product"
//       });
//     }

//     // 🔥 REMOVE VARIANT
//     product.variants = product.variants.filter(
//       v => v.barcode !== barcodeNumber
//     );

//     // 🔁 RECALCULATE PRICE RANGE
//     const effectivePrices = product.variants.map(v =>
//       v.price.sale != null ? v.price.sale : v.price.base
//     );

//     product.priceRange = {
//       min: Math.min(...effectivePrices),
//       max: Math.max(...effectivePrices)
//     };

//     // 🔁 RECALCULATE STOCK
//     product.totalStock = product.variants.reduce(
//       (sum, v) => sum + (v.inventory.quantity || 0),
//       0
//     );

//     await product.save();

//     return res.status(200).json({
//       success: true,
//       message: "Variant deleted successfully",
//       product
//     });

//   } catch (error) {
//     console.error("Delete variant error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error deleting variant",
//       error: error.message
//     });
//   }
// };

// //get variant by barcode
// // Get product + specific variant by barcode
// const getVariantByBarcode = async (req, res) => {
//   try {
//     const { barcode } = req.params;

//     if (!barcode) {
//       return res.status(400).json({
//         success: false,
//         message: "Barcode is required"
//       });
//     }

//     const barcodeNumber = Number(barcode);

//     if (isNaN(barcodeNumber)) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid barcode"
//       });
//     }

//     // 🔍 Optimized query (returns only matched variant)
//     const product = await Product.findOne(
//       { "variants.barcode": barcodeNumber },
//       {
//         name: 1,
//         slug: 1,
//         brand: 1,
//         category: 1,
//         fomo: 1,
//         soldInfo: 1,
//         "variants.$": 1
//       }
//     );

//     if (!product) {
//       return res.status(404).json({
//         success: false,
//         message: "No product found for this barcode"
//       });
//     }

//     return res.status(200).json({
//       success: true,
//       product: {
//         _id: product._id,
//         name: product.name,
//         slug: product.slug,
//         brand: product.brand,
//         category: product.category,
//         fomo: product.fomo,
//         soldInfo: product.soldInfo
//       },
//       variant: product.variants[0] // matched variant
//     });

//   } catch (error) {
//     console.error("Get variant by barcode error:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Error fetching variant",
//       error: error.message
//     });
//   }
// };

// //  const previewCSV = async (req, res) => {
// //   try {
// //     if (!req.file) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "CSV file is required",
// //       });
// //     }

// //     const rows = [];
// //     const errors = [];

// //     fs.createReadStream(req.file.path)
// //       .pipe(csv({
// //         mapHeaders: ({ header }) => header.trim(),
// //       }))
// //       .on("data", (row) => rows.push(row))
// //       .on("end", async () => {
// //         // Basic validation
// //         rows.forEach((row, index) => {
// //           if (!row.name || !row.category || !row.basePrice) {
// //             errors.push({
// //               row: index + 1,
// //               message: "Missing required fields (name, category, basePrice)",
// //             });
// //           }
// //         });

// //         // Clean up file
// //         fs.unlinkSync(req.file.path);

// //         return res.status(200).json({
// //           success: true,
// //           preview: rows.slice(0, 20), // Send first 20 rows for preview
// //           total: rows.length,
// //           errors,
// //         });
// //       });
// //   } catch (error) {
// //     return res.status(500).json({
// //       success: false,
// //       message: "Preview failed",
// //       error: error.message,
// //     });
// //   }
// // };



// // ═══════════════════════════════════════════════════════════════════════
// // STEP 1 — previewCSV
// // POST /admin/products/preview-csv
// // Replaces the old previewCSV — now handles CSV + Excel,
// // groups multi-row variants, validates, returns full preview.
// // NO DB writes. NO Cloudinary. Just parse + validate.
// // ═══════════════════════════════════════════════════════════════════════
// const previewCSV = async (req, res) => {
//   const filePath = req.file?.path;
 
//   try {
//     if (!filePath) {
//       return res.status(400).json({ success: false, message: 'No file uploaded' });
//     }
 
//     // ── Parse ──
//     let rows;
//     try {
//       rows = parseSpreadsheet(filePath);
//     } catch (e) {
//       return res.status(422).json({
//         success: false,
//         message: `Could not parse file: ${e.message}. Make sure it is a valid CSV or Excel file.`,
//       });
//     }
 
//     if (!rows.length) {
//       return res.status(422).json({ success: false, message: 'File appears to be empty' });
//     }
 
//     // ── Required column check ──
//     const firstRow     = rows[0];
//     const requiredCols = ['name', 'category', 'baseprice'];
//     const missing      = requiredCols.filter(c => !(c in firstRow));
 
//     if (missing.length) {
//       return res.status(422).json({
//         success    : false,
//         message    : `Missing required columns: ${missing.join(', ')}. Check headers and re-upload.`,
//         missingCols: missing,
//       });
//     }
 
//     // ── Group + validate ──
//     const products    = groupRowsIntoProducts(rows);
//     const validCount  = products.filter(p => validateProduct(p).length === 0).length;
//     const invalidCount= products.length - validCount;
 
//     const preview = products.map(prod => {
//       const errors = validateProduct(prod);
//       return {
//         name          : prod.name,
//         title         : prod.title,
//         category      : prod.category,
//         brand         : prod.brand,
//         status        : prod.status,
//         variantCount  : prod.variants.length,
//         barcodes      : prod.variants.map(v => v.barcode).filter(Boolean),
//         totalQuantity : prod.variants.reduce((s, v) => s + v.inventory.quantity, 0),
//         priceRange: {
//           min: Math.min(...prod.variants.map(v => v.price.sale ?? v.price.base)),
//           max: Math.max(...prod.variants.map(v => v.price.base)),
//         },
//         errors,
//         hasErrors: errors.length > 0,
//       };
//     });
 
//     return res.status(200).json({
//       success      : true,
//       message      : 'File parsed successfully',
//       totalRows    : rows.length,
//       totalProducts: products.length,
//       validCount,
//       invalidCount,
//       preview,
//       _parsedData  : products, // sent back to frontend, re-submitted in Step 2
//     });
 
//   } catch (err) {
//     console.error('[BULK:previewCSV]', err);
//     return res.status(500).json({ success: false, message: 'Server error during preview', error: err.message });
//   } finally {
//     if (filePath) fsp.unlink(filePath).catch(() => {});
//   }
// };
// module.exports = {
//   createProduct,
//   updateProduct,
//   deleteProduct,
//   bulkDelete,
//   hardDeleteProduct,
//   bulkHardDelete,
//   restoreProduct,
//   getLowStockProducts,
//   getArchivedProducts,
//   getDraftProducts,
//   getAllActiveProducts,
//   getProductBySlug , 
//    bulkCreateProducts ,
//    bulkRestore  , 
//    importProductsFromCSV ,
//    getAllProductsAdmin , 
//    addVariant,
//    deleteVariant,
//    getVariantByBarcode,
//    previewCSV
// };