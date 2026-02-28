
const mongoose = require('mongoose');

//
// IMAGE SUB-SCHEMA
//
const imageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    altText: { type: String, default: '' },
    order: { type: Number, default: 0 }
  },
  { _id: false }
);


//
// VARIANT SUB-SCHEMA (Purchasable Unit)
//
const variantSchema = new mongoose.Schema(
  {
    sku: {
      type: String,
      required: true,
      uppercase: true,
      trim: true
    },

    attributes: [
      {
        key: { type: String, trim: true },
        value: { type: String, trim: true }
      }
    ],
    images: {
      type: [imageSchema],
      validate: [
        function (val) {
          return !val || val.length <= 5;
        },
        'A variant can have at most 5 images'
      ]
    },
    price: {
      base: { type: Number, required: true, min: 0 },
      sale: { type: Number, default: null },
      costPrice: { type: Number, default: null, select: false },
      saleStartDate: { type: Date, default: null },
      saleEndDate: { type: Date, default: null }
    },

    inventory: {
      quantity: { type: Number, default: 0 },
      lowStockThreshold: { type: Number, default: 5 },
      trackInventory: { type: Boolean, default: true }
    },

    isActive: { type: Boolean, default: true }
  },
  { _id: true }
);

//
// VARIANT VIRTUALS
//
variantSchema.virtual('isSaleActive').get(function () {
  const now = new Date();

  if (!this.price.sale) return false;
  if (this.price.sale >= this.price.base) return false;
  if (this.price.saleStartDate && now < this.price.saleStartDate) return false;
  if (this.price.saleEndDate && now > this.price.saleEndDate) return false;

  return true;
});

variantSchema.virtual('finalPrice').get(function () {
  return this.isSaleActive ? this.price.sale : this.price.base;
});

variantSchema.virtual('discountPercentage').get(function () {
  if (!this.isSaleActive) return 0;

  return Math.round(
    ((this.price.base - this.price.sale) / this.price.base) * 100
  );
});

variantSchema.set('toJSON', { virtuals: true });
variantSchema.set('toObject', { virtuals: true });

//
// PRODUCT SCHEMA
//
const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, index: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    title: { type: String, required: true },
    description: { type: String, default: '' },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true
    },

    brand: { type: String, default: 'Generic', trim: true },

    // Variants
    variants: {
      type: [variantSchema],
      default: []
    },

    // Marketing
    soldInfo: {
      enabled: { type: Boolean, default: false },
      count: { type: Number, default: 0 }
    },

    fomo: {
      enabled: { type: Boolean, default: false },
      type: {
        type: String,
        enum: ['viewing_now', 'product_left', 'custom'],
        default: 'viewing_now'
      },
      viewingNow: { type: Number, default: 0 },
      productLeft: { type: Number, default: 0 },
      customMessage: { type: String, default: '' }
    },

    // Shipping
    shipping: {
      weight: { type: Number, default: 0 },
      dimensions: {
        length: { type: Number, default: 0 },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 }
      }
    },

    attributes: [{ key: String, value: String }],

    isFeatured: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['draft', 'active', 'archived'],
      default: 'draft'
    }
  },
  { timestamps: true }
);

//
// AUTO-CREATE DEFAULT VARIANT IF NONE PROVIDED
//
productSchema.pre('validate', function () {
  if (!this.variants || this.variants.length === 0) {
    this.variants = [
      {
        sku: `${this.slug}-DEFAULT`,
        attributes: [],
        price: { base: 0 },
        inventory: { quantity: 0 },
        isActive: true
      }
    ];
  }
});

//
// VALIDATE VARIANT PRICING RULES
//
productSchema.pre('save', function () {
  for (const v of this.variants) {
    if (v.price.sale != null && v.price.sale >= v.price.base) {
      throw new Error('Sale price must be less than base price');
    }

    if (
      v.price.saleStartDate &&
      v.price.saleEndDate &&
      v.price.saleStartDate > v.price.saleEndDate
    ) {
      throw new Error('Sale start date cannot be after sale end date');
    }
  }
});

//
// PRODUCT-LEVEL VIRTUALS
//
productSchema.virtual('minPrice').get(function () {
  if (!Array.isArray(this.variants)) return null;

  const active = this.variants.filter(v => v.isActive);
  if (!active.length) return null;

  const prices = active.map(v => v.finalPrice).filter(p => p != null);
  return prices.length ? Math.min(...prices) : null;
});

productSchema.virtual('maxPrice').get(function () {
  if (!Array.isArray(this.variants)) return null;

  const active = this.variants.filter(v => v.isActive);
  if (!active.length) return null;

  const prices = active.map(v => v.finalPrice).filter(p => p != null);
  return prices.length ? Math.max(...prices) : null;
});

productSchema.virtual('inStock').get(function () {
  if (!Array.isArray(this.variants)) return false;

  return this.variants.some(v =>
    v?.inventory?.trackInventory
      ? v.inventory.quantity > 0
      : true
  );
});

 productSchema.virtual('soldLabel').get(function () {
  if (!this.soldInfo?.enabled) return null;
  return `${this.soldInfo.count} people bought this product`;
});

productSchema.virtual('fomoLabel').get(function () {
  if (!this.fomo?.enabled) return null;

  switch (this.fomo.type) {
    case 'viewing_now':
      return `${this.fomo.viewingNow} people are viewing this right now`;

    case 'product_left':
      return `Only ${this.fomo.productLeft} left in stock`;

    case 'custom':
      return this.fomo.customMessage || null;

    default:
      return null;
  }
});

productSchema.virtual('maxDiscountPercentage').get(function () {
  if (!Array.isArray(this.variants)) return 0;

  const active = this.variants.filter(v => v.isActive);
  if (!active.length) return 0;

  const discounts = active.map(v => v.discountPercentage || 0);
  return discounts.length ? Math.max(...discounts) : 0;
});

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

//
// INDEXES
//
productSchema.index({ name: 'text', title: 'text', description: 'text' });
productSchema.index({ category: 1, status: 1 });
productSchema.index({ isFeatured: 1 });
productSchema.index({ 'variants.sku': 1 }, { unique: true, sparse: true });
productSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Product', productSchema);