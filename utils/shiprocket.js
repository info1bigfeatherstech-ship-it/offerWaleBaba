// utils/shiprocket.js
const axios = require('axios');
const DeliveryZone = require('../models/delieveryZone'); // ✅ Fixed spelling

class ShiprocketService {
    constructor() {
        this.baseURL = process.env.SHIPROCKET_BASE_URL;
        this.token = null;
        this.tokenExpiry = null;
        this.isEnabled = process.env.SHIPROCKET_ENABLED === 'true';
    }

    // ========== MOCK METHODS (For Testing) ==========
    mockDeliveryCharges(pincode, weight = 1) {
        const freeDeliveryPincodes = ['560001', '400001', '110001'];
        
        if (freeDeliveryPincodes.includes(pincode)) {
            return {
                isDeliverable: true,
                deliveryCharges: 0,
                estimatedDays: "2-3",
                courierName: "Express Delivery",
                message: "Free delivery available"
            };
        }
        
        if (pincode.startsWith('56')) {
            return {
                isDeliverable: true,
                deliveryCharges: 40,
                estimatedDays: "3-4",
                courierName: "Standard Delivery",
                message: "Delivery available"
            };
        }
        
        if (pincode.startsWith('40')) {
            return {
                isDeliverable: true,
                deliveryCharges: 50,
                estimatedDays: "3-4",
                courierName: "Standard Delivery",
                message: "Delivery available"
            };
        }
        
        if (pincode.startsWith('11')) {
            return {
                isDeliverable: true,
                deliveryCharges: 45,
                estimatedDays: "3-4",
                courierName: "Standard Delivery",
                message: "Delivery available"
            };
        }
        
        return {
            isDeliverable: true,
            deliveryCharges: 60,
            estimatedDays: "5-7",
            courierName: "Standard Delivery",
            message: "Delivery available with standard charges"
        };
    }

    // ========== REAL API METHODS ==========
    async getAuthToken() {
        if (!this.isEnabled) return null;
        
        if (this.token && this.tokenExpiry > Date.now()) {
            return this.token;
        }

        try {
            const response = await axios.post(`${this.baseURL}/auth/login`, {
                email: process.env.SHIPROCKET_EMAIL,
                password: process.env.SHIPROCKET_PASSWORD
            });

            this.token = response.data.token;
            this.tokenExpiry = Date.now() + (response.data.expires_in * 1000);
            return this.token;
        } catch (error) {
            console.error('Shiprocket auth failed:', error.message);
            this.isEnabled = false;
            return null;
        }
    }

    async checkDeliveryAvailability(pincode, weight = 1, codAmount = 0) {
        if (!this.isEnabled) {
            console.log('Using mock delivery check for pincode:', pincode);
            return this.mockDeliveryCharges(pincode, weight);
        }

        try {
            const token = await this.getAuthToken();
            if (!token) {
                return this.mockDeliveryCharges(pincode, weight);
            }
            
            const response = await axios.post(`${this.baseURL}/courier/serviceability`, {
                pickup_postcode: process.env.STORE_PINCODE || '560001',
                delivery_postcode: pincode,
                weight: weight,
                cod_amount: codAmount
            }, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const availableCouriers = response.data.data?.available_courier_list || [];
            
            if (availableCouriers.length === 0) {
                return {
                    isDeliverable: false,
                    message: 'No courier service available for this pincode',
                    deliveryCharges: 0,
                    estimatedDays: null
                };
            }

            const bestCourier = availableCouriers.reduce((best, current) => {
                return (current.rate < best.rate) ? current : best;
            });

            return {
                isDeliverable: true,
                deliveryCharges: bestCourier.rate,
                estimatedDays: bestCourier.estimated_delivery_days || "3-5",
                courierName: bestCourier.courier_name,
                courierId: bestCourier.courier_id,
                message: "Delivery available"
            };

        } catch (error) {
            console.error('Shiprocket API failed, using mock:', error.message);
            return this.mockDeliveryCharges(pincode, weight);
        }
    }

    async getDeliveryCharges(pincode, weight = 1) {
        const result = await this.checkDeliveryAvailability(pincode, weight, 0);
        return {
            deliveryCharges: result.deliveryCharges,
            isDeliverable: result.isDeliverable,
            estimatedDays: result.estimatedDays,
            courierName: result.courierName
        };
    }

    async createShipment(order) {
        if (!this.isEnabled) {
            console.log('Shipment service disabled, skipping shipment creation');
            return { 
                success: true, 
                mock: true,
                trackingNumber: `MOCK-${order.orderId}`,
                courier: "Mock Courier"
            };
        }

        try {
            const token = await this.getAuthToken();
            if (!token) {
                return { success: false, error: 'No auth token' };
            }

            const shipmentData = {
                order_id: order.orderId,
                order_date: order.createdAt,
                pickup_location: process.env.PICKUP_PINCODE || '560001',
                channel_id: 1,
                comment: `Order #${order.orderId}`,
                billing_customer_name: order.addressSnapshot?.fullName || 'Customer',
                billing_last_name: '',
                billing_address: order.addressSnapshot?.addressLine1 || '',
                billing_address_2: order.addressSnapshot?.addressLine2 || '',
                billing_city: order.addressSnapshot?.city || '',
                billing_pincode: order.addressSnapshot?.postalCode || '',
                billing_state: order.addressSnapshot?.state || '',
                billing_country: order.addressSnapshot?.country || 'India',
                billing_email: order.userEmail || '',
                billing_phone: order.addressSnapshot?.phone || '',
                shipping_is_billing: true,
                order_items: order.items.map(item => ({
                    name: item.productId?.name || 'Product',
                    sku: item.sku || `SKU-${item.productId}`,
                    units: item.quantity,
                    selling_price: item.priceSnapshot?.sale || item.priceSnapshot?.base || 0,
                    discount: 0,
                    tax: 0,
                    hsn: 0
                })),
                payment_method: order.paymentInfo?.method === 'cod' ? 'COD' : 'Prepaid',
                sub_total: order.subtotal,
                length: 10,
                breadth: 10,
                height: 10,
                weight: this.calculateTotalWeight(order.items)
            };

            const response = await axios.post(`${this.baseURL}/orders/create/adhoc`, shipmentData, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            return {
                success: true,
                shipmentId: response.data.shipment_id,
                trackingNumber: response.data.tracking_number,
                courier: response.data.courier_name,
                labelUrl: response.data.label_url
            };

        } catch (error) {
            console.error('Shipment creation failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    calculateTotalWeight(items) {
        return items.reduce((total, item) => total + (item.quantity * 0.5), 0);
    }
}

module.exports = new ShiprocketService();