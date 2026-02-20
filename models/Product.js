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

const imageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    altText: { type: String, default: '' },
    order: { type: Number, default: 0 }
  },
  { _id: false }
);

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

    description: {
      type: String,
      required: true
    },

    shortDescription: {
      type: String,
      maxLength: 250
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
      default: 'Generic'
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
    // PRICING SYSTEM
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
        select: false // Hidden from normal queries
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
    // INVENTORY
    // =========================
    inventory: {
      quantity: { type: Number, default: 0 },
      lowStockThreshold: { type: Number, default: 5 },
      trackInventory: { type: Boolean, default: true }
    },

    // =========================
    // SHIPPING
    // =========================
    shipping: {
      weight: { type: Number, default: 0 }, // grams
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

 // =========================
    // FOMO (Marketing Boost)
    // =========================
    fomo: {
      enabled: { type: Boolean, default: false },

      type: {
        type: String,
        enum: ['sold_count', 'viewing_now', 'custom_message'],
        default: 'sold_count'
      },

      value: {
        type: Number,
        default: 0
      },

      message: {
        type: String,
        default: ''
      }
    },

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
// VIRTUALS (AUTO LOGIC)
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

productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });


//
// =========================
// VALIDATIONS
// =========================
//

productSchema.pre('save', function () {
  // Sale must be less than base
  if (
    this.price.sale &&
    this.price.sale >= this.price.base
  ) {
    throw new Error('Sale price must be less than base price');
  }

  // Sale start cannot be after end
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
// INDEXES (Performance)
// =========================
//

productSchema.index({ name: 'text', description: 'text' });
productSchema.index({ category: 1, status: 1 });
productSchema.index({ isFeatured: 1 });
productSchema.index({ 'price.base': 1 });
productSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Product', productSchema);
