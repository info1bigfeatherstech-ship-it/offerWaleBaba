const Address = require('../models/Address');

// Add a new address
exports.addAddress = async (req, res) => {
    try {
        const { fullName, phone, addressLine1, addressLine2, city, state, postalCode, country, isDefault } = req.body;
        const address = new Address({
            userId: req.user._id,
            fullName,
            phone,
            addressLine1,
            addressLine2,
            city,
            state,
            postalCode,
            country,
            isDefault
        });
        await address.save();
        res.status(201).json({ message: 'Address added successfully', address });
    } catch (error) {
        res.status(500).json({ message: 'Error adding address', error });
    }
};

// Get all addresses for a user
exports.getAddresses = async (req, res) => {
    try {
        const addresses = await Address.find({ userId: req.user._id });
        res.status(200).json(addresses);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching addresses', error });
    }
};

// Update an address
exports.updateAddress = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedAddress = await Address.findByIdAndUpdate(id, req.body, { new: true });
        if (!updatedAddress) return res.status(404).json({ message: 'Address not found' });
        res.status(200).json({ message: 'Address updated successfully', updatedAddress });
    } catch (error) {
        res.status(500).json({ message: 'Error updating address', error });
    }
};

// Delete an address
exports.deleteAddress = async (req, res) => {
    try {
        const { id } = req.params;
        const deletedAddress = await Address.findByIdAndDelete(id);
        if (!deletedAddress) return res.status(404).json({ message: 'Address not found' });
        res.status(200).json({ message: 'Address deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting address', error });
    }
};