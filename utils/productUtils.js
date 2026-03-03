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

module.exports = { generateSlug, generateSku };
