const slugify = require('slugify');
const Product = require('../models/Product');

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
const generateSku = async () => {
  let candidateSku;
  let attempts = 0;

  do {
    candidateSku = `SKU-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
    attempts += 1;
    if (attempts > 10) {
      throw new Error('Failed to generate unique SKU after 10 attempts');
    }
  } while (await Product.exists({ sku: candidateSku }));

  return candidateSku;
};

module.exports = { generateSlug, generateSku };
