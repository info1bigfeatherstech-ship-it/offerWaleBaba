const mongoose = require('mongoose');

const imageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  publicId: { type: String, required: true },
  altText: { type: String, default: '' },
  order: { type: Number, default: 0 }
}, { _id: false });

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, index: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: false },
    price: {
      base: { type: Number, required: true, default: 0 },
      sale: { type: Number, default: 0 }
    },
    sku: { type: String, required: true, unique: true, index: true },
    inventory: {
      quantity: { type: Number, default: 0 },
      trackInventory: { type: Boolean, default: true },
      lowStockThreshold: { type: Number, default: 5 }
    },
    images: [imageSchema],
    variants: { type: Array, default: [] },
    status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Product', productSchema);
