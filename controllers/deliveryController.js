// controllers/deliveryController.js
const ShiprocketService = require('../utils/shiprocket');
const DeliveryZone = require('../models/DeliveryZone');
const Cart = require('../models/cart');
const Product = require('../models/Product');

// Calculate total weight of cart items
const calculateCartWeight = async (cartItems) => {
    let totalWeight = 0;
    for (const item of cartItems) {
        const product = await Product.findById(item.productId);
        totalWeight += item.quantity * (product?.shipping?.weight || 0.5);
    }
    return totalWeight;
};

// ========== PRODUCTION VERSION ==========
exports.checkDeliveryAvailability = async (req, res) => {
    try {
        const { pincode, cartId } = req.body;
        
        if (!pincode || !/^\d{6}$/.test(pincode)) {
            return res.status(400).json({
                success: false,
                message: 'Valid 6-digit pincode is required'
            });
        }

        // Get cart weight if cartId provided
        let totalWeight = 1; // Default weight
        if (cartId) {
            const cart = await Cart.findById(cartId);
            if (cart && cart.items.length) {
                totalWeight = await calculateCartWeight(cart.items);
            }
        }

        const result = await ShiprocketService.checkDeliveryAvailability(pincode, totalWeight);
        
        return res.status(200).json({
            success: true,
            isDeliverable: result.isDeliverable,
            deliveryCharges: result.deliveryCharges,
            estimatedDays: result.estimatedDays,
            courierName: result.courierName,
            message: result.message,
            pincode: pincode
        });
        
    } catch (error) {
        console.error('Delivery check error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error checking delivery availability',
            error: error.message
        });
    }
};

exports.getDeliveryCharges = async (req, res) => {
    try {
        const { pincode } = req.params;
        const { weight = 1 } = req.query;
        
        if (!pincode || !/^\d{6}$/.test(pincode)) {
            return res.status(400).json({
                success: false,
                message: 'Valid 6-digit pincode is required'
            });
        }

        const result = await ShiprocketService.getDeliveryCharges(pincode, parseFloat(weight));
        
        return res.status(200).json({
            success: true,
            isServiceable: result.isDeliverable,
            deliveryCharges: result.deliveryCharges,
            estimatedDays: result.estimatedDays,
            courierName: result.courierName
        });
        
    } catch (error) {
        console.error('Get delivery charges error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error fetching delivery charges',
            error: error.message
        });
    }
};

// ========== ADMIN FUNCTIONS ==========
exports.addDeliveryZone = async (req, res) => {
    try {
        const { name, pincodes, baseCharge, perKgCharge, freeDeliveryAbove, estimatedDays } = req.body;

        const deliveryZone = new DeliveryZone({
            name,
            pincodes,
            baseCharge,
            perKgCharge,
            freeDeliveryAbove,
            estimatedDays
        });

        await deliveryZone.save();

        return res.status(201).json({
            success: true,
            message: 'Delivery zone added successfully',
            deliveryZone
        });
    } catch (error) {
        console.error('Add delivery zone error:', error);
        return res.status(500).json({
            success: false,
            message: 'Error adding delivery zone',
            error: error.message
        });
    }
};

exports.getDeliveryZones = async (req, res) => {
    try {
        const zones = await DeliveryZone.find({ isActive: true });
        return res.json({
            success: true,
            zones
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Error fetching delivery zones',
            error: error.message
        });
    }
};

exports.updateDeliveryZone = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const zone = await DeliveryZone.findByIdAndUpdate(id, updates, { new: true });
        if (!zone) {
            return res.status(404).json({
                success: false,
                message: 'Delivery zone not found'
            });
        }

        return res.json({
            success: true,
            message: 'Delivery zone updated',
            deliveryZone: zone
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Error updating delivery zone',
            error: error.message
        });
    }
};