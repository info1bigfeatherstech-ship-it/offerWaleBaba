const mongoose = require('mongoose');

const wholesalerDetailsSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
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
    }
}, { timestamps: true });

module.exports = mongoose.model('WholesalerDetails', wholesalerDetailsSchema);