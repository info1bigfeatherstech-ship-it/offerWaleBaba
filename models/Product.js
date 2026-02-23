// const mongoose = require('mongoose');

// const imageSchema = new mongoose.Schema({
//   url: { type: String, required: true },
//   publicId: { type: String, required: true },
//   altText: { type: String, default: '' },
//   order: { type: Number, default: 0 }
// }, { _id: false });

// const productSchema = new mongoose.Schema(
//   {
//     name: { type: String, required: true, trim: true, index: true },
//     slug: { type: String, required: true, unique: true, index: true },
//     description: { type: String, default: '' },
//     category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: false },
//     price: {
//       base: { type: Number, required: true },
//       sale: { type: Number }
//     },
//     sku: { type: String, required: true, unique: true, index: true },
//     inventory: {
//       quantity: { type: Number, default: 0 },
//       trackInventory: { type: Boolean, default: true },
//       lowStockThreshold: { type: Number, default: 5 }
//     },
//     images: [imageSchema],
//     variants: { type: Array, default: [] },
//     status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft' }
//   },
//   { timestamps: true }
// );

// module.exports = mongoose.model('Product', productSchema);


const mongoose = require('mongoose');

//
// =========================
// IMAGE SCHEMA
// =========================
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
// =========================
// PRODUCT SCHEMA
// =========================
//
const productSchema = new mongoose.Schema(
  {
    // =========================
    // BASIC DETAILS
    // =========================
    name: {
      type: String,
      required: true,
      trim: true,
      index: true
    },

    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true
    },

    // OLD description ➜ title
    title: {
      type: String,
      required: true
    },

    // OLD shortDescription ➜ description (NO LIMIT)
    description: {
      type: String,
      default: ''
    },

    // =========================
    // CATEGORY & BRAND
    // =========================
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true
    },

    brand: {
      type: String,
      default: 'Generic',
      trim: true
    },

    // =========================
    // IDENTIFICATION
    // =========================
    sku: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      index: true
    },

    // =========================
    // PRICING
    // =========================
    price: {
      base: {
        type: Number,
        required: true,
        min: 0
      },

      sale: {
        type: Number,
        default: null
      },

      costPrice: {
        type: Number,
        default: null,
        select: false
      },

      saleStartDate: {
        type: Date,
        default: null
      },

      saleEndDate: {
        type: Date,
        default: null
      }
    },

    // =========================
    // INVENTORY (REAL)
    // =========================
    inventory: {
      quantity: { type: Number, default: 0 },
      lowStockThreshold: { type: Number, default: 5 },
      trackInventory: { type: Boolean, default: true }
    },

    // =========================
    // FAKE SOLD INFO (Admin Controlled)
    // =========================
    soldInfo: {
      enabled: { type: Boolean, default: false },
      count: { type: Number, default: 0 }
    },

    // =========================
    // FAKE FOMO (Admin Controlled)
    // =========================
    fomo: {
      enabled: { type: Boolean, default: false },

      type: {
        type: String,
        enum: ['viewing_now', 'product_left', 'custom'],
        default: 'viewing_now'
      },

      viewingNow: {
        type: Number,
        default: 0
      },

      productLeft: {
        type: Number,
        default: 0
      },

      customMessage: {
        type: String,
        default: ''
      }
    },

    // =========================
    // SHIPPING
    // =========================
    shipping: {
      weight: { type: Number, default: 0 },
      dimensions: {
        length: { type: Number, default: 0 },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 }
      }
    },

    // =========================
    // MEDIA
    // =========================
    images: [imageSchema],

    // =========================
    // ATTRIBUTES
    // =========================
    attributes: [
      {
        key: { type: String },
        value: { type: String }
      }
    ],

    isFeatured: {
      type: Boolean,
      default: false
    },

    status: {
      type: String,
      enum: ['draft', 'active', 'archived'],
      default: 'draft'
    }
  },
  { timestamps: true }
);

//
// =========================
// VIRTUALS
// =========================
//

productSchema.virtual('isSaleActive').get(function () {
  const now = new Date();

  if (!this.price.sale) return false;
  if (this.price.sale >= this.price.base) return false;

  if (this.price.saleStartDate && now < this.price.saleStartDate)
    return false;

  if (this.price.saleEndDate && now > this.price.saleEndDate)
    return false;

  return true;
});

productSchema.virtual('finalPrice').get(function () {
  return this.isSaleActive
    ? this.price.sale
    : this.price.base;
});

productSchema.virtual('discountPercentage').get(function () {
  if (!this.isSaleActive) return 0;

  return Math.round(
    ((this.price.base - this.price.sale) / this.price.base) * 100
  );
});
// =========================
// MARKETING VIRTUALS
// =========================

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

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

//
// =========================
// VALIDATIONS
// =========================
//

productSchema.pre('save', function () {
  if (this.price.sale && this.price.sale >= this.price.base) {
    throw new Error('Sale price must be less than base price');
  }

  if (
    this.price.saleStartDate &&
    this.price.saleEndDate &&
    this.price.saleStartDate > this.price.saleEndDate
  ) {
    throw new Error('Sale start date cannot be after sale end date');
  }
});

//
// =========================
// INDEXES
// =========================
//

productSchema.index({ name: 'text', title: 'text', description: 'text' });
productSchema.index({ category: 1, status: 1 });
productSchema.index({ isFeatured: 1 });
productSchema.index({ 'price.base': 1 });
productSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Product', productSchema);