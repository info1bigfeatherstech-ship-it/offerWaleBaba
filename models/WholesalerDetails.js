const mongoose = require('mongoose');

const wholesalerDetailsSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: false,
        default: null
    },
    fullName: {
        type: String,
        required: true
    },
    whatsappNumber: {
        type: String,
        required: true
    },
    mobileNumber: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true
    },
    permanentAddress: {
        type: String,
        required: true
    },
    haveShop: {
        type: Boolean,
        required: true
    },
    businessAddress: {
        type: String,
        required: true
    },
    deliveryAddress: {
        type: String,
        required: true
    },
    sellingPlaceFrom: {
        type: String,
        required: true
    },
    sellingZoneCity: {
        type: String,
        required: true
    },
    productCategory: {
        type: String,
        required: true
    },
    monthlyEstimatedPurchase: {
        type: Number,
        required: true
    },
    idProofUpload: {
        type: String,
        required: true
    },
    businessAddressProofUpload: {
        type: String,
        required: true
    },
    isApproved: {
        type: Boolean,
        default: false
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'activated'],
        default: 'pending',
        index: true
    },
    reviewReason: {
        type: String,
        default: ''
    },
    reviewedAt: {
        type: Date,
        default: null
    },
    reviewedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    linkedUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    activationOtpHash: {
        type: String,
        default: null,
        select: false
    },
    activationOtpExpiresAt: {
        type: Date,
        default: null
    },
    activationOtpSentAt: {
        type: Date,
        default: null
    },
    activationOtpAttempts: {
        type: Number,
        default: 0
    },
    activatedAt: {
        type: Date,
        default: null
    },
    /** Incremented when admin generates a new owner review link; token must match this version. */
    ownerReviewLinkVersion: {
        type: Number,
        default: 0,
        min: 0
    },
    ownerNotifiedAt: {
        type: Date,
        default: null
    },
    ownerNotifiedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    }
}, { timestamps: true });

wholesalerDetailsSchema.index({ mobileNumber: 1, status: 1 });
wholesalerDetailsSchema.index({ email: 1, status: 1 });

module.exports = mongoose.model('WholesalerDetails', wholesalerDetailsSchema);