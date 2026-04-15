const WholesalerDetails = require('../models/WholesalerDetails');
const User = require('../models/User');

// Register as a wholesaler
exports.registerWholesaler = async (req, res) => {
    try {
        const { fullName, whatsappNumber, mobileNumber, email, permanentAddress, haveShop, businessAddress, deliveryAddress, sellingPlaceFrom, sellingZoneCity, productCategory, monthlyEstimatedPurchase, idProofUpload, businessAddressProofUpload } = req.body;

        const wholesalerDetails = new WholesalerDetails({
            userId: req.user._id,
            fullName,
            whatsappNumber,
            mobileNumber,
            email,
            permanentAddress,
            haveShop,
            businessAddress,
            deliveryAddress,
            sellingPlaceFrom,
            sellingZoneCity,
            productCategory,
            monthlyEstimatedPurchase,
            idProofUpload,
            businessAddressProofUpload
        });

        await wholesalerDetails.save();
        res.status(201).json({ message: 'Wholesaler registration request submitted successfully', wholesalerDetails });
    } catch (error) {
        res.status(500).json({ message: 'Error registering wholesaler', error });
    }
};

// Approve wholesaler (admin only)
exports.approveWholesaler = async (req, res) => {
    try {
        const { id } = req.params;
        const wholesaler = await WholesalerDetails.findByIdAndUpdate(id, { isApproved: true }, { new: true });
        if (!wholesaler) return res.status(404).json({ message: 'Wholesaler not found' });

        await User.findByIdAndUpdate(wholesaler.userId, { userType: 'wholesaler' });
        res.status(200).json({ message: 'Wholesaler approved successfully', wholesaler });
    } catch (error) {
        res.status(500).json({ message: 'Error approving wholesaler', error });
    }
};