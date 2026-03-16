const Order = require('../models/Order');
const Address = require('../models/Address');

// Create a new order
exports.createOrder = async (req, res) => {
    try {
        const { items, totalAmount, addressId } = req.body;
        const address = await Address.findById(addressId);
        if (!address) return res.status(404).json({ message: 'Address not found' });

        const order = new Order({
            userId: req.user._id,
            items,
            totalAmount,
            address: addressId
        });
        await order.save();
        res.status(201).json({ message: 'Order created successfully', order });
    } catch (error) {
        res.status(500).json({ message: 'Error creating order', error });
    }
};

// Get a specific order by ID
exports.getOrder = async (req, res) => {
    try {
        const { id } = req.params;
        const order = await Order.findById(id).populate('items.productId').populate('address');
        if (!order) return res.status(404).json({ message: 'Order not found' });
        res.status(200).json(order);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching order', error });
    }
};

// Get all orders for a user
exports.getUserOrders = async (req, res) => {
    try {
        const orders = await Order.find({ userId: req.user._id }).sort({ createdAt: -1 });
        res.status(200).json(orders);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching orders', error });
    }
};

// Update order status (admin only)
exports.updateOrderStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const order = await Order.findByIdAndUpdate(id, { orderStatus: status }, { new: true });
        if (!order) return res.status(404).json({ message: 'Order not found' });
        res.status(200).json({ message: 'Order status updated successfully', order });
    } catch (error) {
        res.status(500).json({ message: 'Error updating order status', error });
    }
};