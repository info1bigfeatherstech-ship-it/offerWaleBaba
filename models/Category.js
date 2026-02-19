const mongoose = require('mongoose');
const slugify = require('slugify');

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
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
      default: ''
    },

    image: {
      url: { type: String },
      publicId: { type: String }
    },

    // For nested categories (Men → Shoes → Running)
    parentCategory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null
    },

    isActive: {
      type: Boolean,
      default: true
    },

    showInMenu: {
      type: Boolean,
      default: true
    },

    order: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

//
// ========================
// AUTO SLUG GENERATION
// ========================
categorySchema.pre('validate', function (next) {
  if (this.name && !this.slug) {
    this.slug = slugify(this.name, { lower: true, strict: true });
  }
  next();
});

//
// ========================
// INDEXES (Performance)
// ========================
categorySchema.index({ name: 'text' });
categorySchema.index({ parentCategory: 1 });
categorySchema.index({ isActive: 1 });

module.exports = mongoose.model('Category', categorySchema);
