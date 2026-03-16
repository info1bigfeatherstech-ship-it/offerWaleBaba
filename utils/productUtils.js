const slugify = require('slugify');
const Product = require('../models/Product');
const crypto = require("crypto");
/**
 * Generate unique slug from product name
 */
const generateSlug = async (name, excludeId = null) => {
  const base = slugify(name, { lower: true, strict: true });
  let candidate = base;
  let suffix = 1;

  while (await Product.exists({ slug: candidate, ...(excludeId && { _id: { $ne: excludeId } }) })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};

/**
 * Generate unique SKU for product
 */
// const generateSku = async () => {
//   let candidateSku;
//   let attempts = 0;

//   do {
//     candidateSku = `SKU-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
//     attempts += 1;
//     if (attempts > 10) {
//       throw new Error('Failed to generate unique SKU after 10 attempts');
//     }
//   } while (
//     // Ensure SKU uniqueness across all variant SKUs
//     await Product.exists({ 'variants.sku': candidateSku })
//   );

//   return candidateSku;
// };

const generateSku = async () => {
  let candidateSku;
  let exists = true;

  while (exists) {
    const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase();
    candidateSku = `SKU-${randomPart}`;
    exists = await Product.exists({ "variants.sku": candidateSku });
  }

  return candidateSku;
};

/**
 * Validate product prices and MOQ
 */
const validateProductPrices = (price) => {
    if (!price.base || price.base <= 0) {
        throw new Error('Base price is required and must be greater than 0');
    }

    if (price.sale != null && price.sale >= price.base) {
        throw new Error('Sale price must be less than base price');
    }

    if (!price.wholesaleBase || price.wholesaleBase <= 0) {
        throw new Error('Wholesale base price is required and must be greater than 0');
    }

    if (price.wholesaleSale != null && price.wholesaleSale >= price.wholesaleBase) {
        throw new Error('Wholesale sale price must be less than wholesale base price');
    }

    if (!price.minimumOrderQuantity || price.minimumOrderQuantity < 1) {
        throw new Error('Minimum order quantity is required and must be at least 1');
    }
};

module.exports = { generateSlug, generateSku, validateProductPrices };
