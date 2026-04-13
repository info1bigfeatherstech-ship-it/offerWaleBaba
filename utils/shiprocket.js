/**
 * Shiprocket v2 API integration + safe mock fallback.
 * Serviceability drives server-side delivery fee (never trust client).
 */

const axios = require('axios');
const mongoose = require('mongoose');
const Product = require('../models/Product');

const DEFAULT_BASE = 'https://apiv2.shiprocket.in/v1';

class ShiprocketService {
  constructor() {
    this.baseURL = String(process.env.SHIPROCKET_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
    this.token = null;
    this.tokenExpiry = 0;
    this.enabled = String(process.env.SHIPROCKET_ENABLED || '').toLowerCase() === 'true';
  }

  mockQuote(pincode, weightKg = 0.5) {
    const pc = String(pincode || '').replace(/\D/g, '').slice(0, 6);
    if (pc.length !== 6) {
      return {
        isDeliverable: false,
        deliveryCharges: 0,
        estimatedDays: null,
        courierName: null,
        message: 'Invalid pincode',
        mock: true
      };
    }
    const w = Math.max(0.05, Number(weightKg) || 0.5);
    const base = 40 + Math.min(120, Math.round(w * 18));
    return {
      isDeliverable: true,
      deliveryCharges: base,
      estimatedDays: '3–5',
      courierName: 'Standard (mock)',
      message: 'Shiprocket disabled — using internal mock tariff',
      mock: true
    };
  }

  async getAuthToken() {
    if (!this.enabled) return null;
    if (this.token && this.tokenExpiry > Date.now() + 5000) return this.token;

    const email = String(process.env.SHIPROCKET_EMAIL || '').trim();
    const password = String(process.env.SHIPROCKET_PASSWORD || '').trim();
    if (!email || !password) {
      console.warn('[Shiprocket] Missing SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD');
      return null;
    }

    try {
      const { data } = await axios.post(
        `${this.baseURL}/external/auth/login`,
        { email, password },
        { timeout: 15000 }
      );
      this.token = data.token;
      const ttlSec = Number(data.expires_in) || 9 * 24 * 3600;
      this.tokenExpiry = Date.now() + ttlSec * 1000;
      return this.token;
    } catch (err) {
      console.error('[Shiprocket] auth failed:', err.response?.data || err.message);
      return null;
    }
  }

  /**
   * @param {string} deliveryPincode
   * @param {object} opts
   * @param {number} opts.weightKg
   * @param {number} opts.lengthCm
   * @param {number} opts.widthCm
   * @param {number} opts.heightCm
   * @param {number} [opts.codAmount] — declared COD value for serviceability
   */
  async checkDeliveryAvailability(deliveryPincode, opts = {}) {
    const pincode = String(deliveryPincode || '').replace(/\D/g, '').slice(0, 6);
    const weight = Math.max(0.05, Number(opts.weightKg) || 0.5);
    const length = Math.max(1, Number(opts.lengthCm) || 10);
    const breadth = Math.max(1, Number(opts.widthCm) || 10);
    const height = Math.max(1, Number(opts.heightCm) || 10);
    const codAmount = Math.max(0, Number(opts.codAmount) || 0);

    if (pincode.length !== 6) {
      return {
        isDeliverable: false,
        deliveryCharges: 0,
        estimatedDays: null,
        courierName: null,
        message: 'Valid 6-digit pincode required'
      };
    }

    if (!this.enabled) {
      return this.mockQuote(pincode, weight);
    }

    const token = await this.getAuthToken();
    if (!token) {
      return this.mockQuote(pincode, weight);
    }

    const pickup = String(process.env.STORE_PINCODE || process.env.PICKUP_PINCODE || '560001').replace(/\D/g, '').slice(0, 6);

    try {
      const { data } = await axios.post(
        `${this.baseURL}/external/courier/serviceability`,
        {
          pickup_postcode: pickup,
          delivery_postcode: pincode,
          weight,
          cod: codAmount > 0 ? 1 : 0,
          cod_amount: codAmount > 0 ? codAmount : undefined,
          length,
          breadth,
          height
        },
        {
          timeout: 20000,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        }
      );

      const list = data?.data?.available_courier_companies || data?.data?.available_courier_list || [];
      if (!Array.isArray(list) || list.length === 0) {
        return {
          isDeliverable: false,
          deliveryCharges: 0,
          estimatedDays: null,
          courierName: null,
          message: 'No courier available for this route',
          mock: false
        };
      }

      const best = list.reduce((a, b) => {
        const ra = Number(a.rate) || Number(a.freight_charge) || Infinity;
        const rb = Number(b.rate) || Number(b.freight_charge) || Infinity;
        return rb < ra ? b : a;
      });

      const rate = Number(best.rate ?? best.freight_charge ?? best.estimated_delivery_days) || 0;
      const days =
        best.estimated_delivery_days != null
          ? String(best.estimated_delivery_days)
          : best.etd || '3–5';

      return {
        isDeliverable: true,
        deliveryCharges: Math.max(0, rate),
        estimatedDays: days,
        courierName: best.courier_name || best.airline_name || 'Courier',
        courierCompanyId: best.courier_company_id,
        message: 'Delivery available',
        mock: false
      };
    } catch (err) {
      console.error('[Shiprocket] serviceability failed:', err.response?.data || err.message);
      return this.mockQuote(pincode, weight);
    }
  }

  async getDeliveryCharges(pincode, weightKg = 1, dimensionOpts = {}) {
    const r = await this.checkDeliveryAvailability(pincode, {
      weightKg,
      lengthCm: dimensionOpts.lengthCm,
      widthCm: dimensionOpts.widthCm,
      heightCm: dimensionOpts.heightCm,
      codAmount: dimensionOpts.codAmount
    });
    return {
      deliveryCharges: r.deliveryCharges,
      isDeliverable: r.isDeliverable,
      estimatedDays: r.estimatedDays,
      courierName: r.courierName,
      courierCompanyId: r.courierCompanyId,
      message: r.message,
      mock: r.mock
    };
  }

  /**
   * Create Shiprocket forward shipment after payment (best-effort).
   */
  async createShipment(order) {
    if (!this.enabled) {
      return {
        success: true,
        mock: true,
        trackingNumber: `MOCK-${order.orderId}`,
        courier: 'Mock Courier'
      };
    }

    const token = await this.getAuthToken();
    if (!token) {
      return { success: false, error: 'Shiprocket auth failed' };
    }

    const pickupLocation = String(process.env.SHIPROCKET_PICKUP_LOCATION || process.env.PICKUP_LOCATION_NICKNAME || 'Primary').trim();

    const orderItems = [];
    for (const item of order.items || []) {
      let length = 10;
      let breadth = 10;
      let height = 10;
      let weight = 0.5;
      let name = 'Product';
      let sku = 'SKU';

      if (item.productId) {
        const pid = mongoose.Types.ObjectId.isValid(item.productId) ? item.productId : item.productId?._id;
        if (pid) {
          const product = await Product.findById(pid).lean();
          if (product) {
            name = product.name || name;
            length = product.shipping?.dimensions?.length || length;
            breadth = product.shipping?.dimensions?.width || breadth;
            height = product.shipping?.dimensions?.height || height;
            weight = product.shipping?.weight || weight;
            const v = (product.variants || []).find((x) => String(x._id) === String(item.variantId));
            if (v?.sku) sku = v.sku;
          }
        }
      }

      const unit = Number(item.priceSnapshot?.sale ?? item.priceSnapshot?.base ?? 0);
      orderItems.push({
        name,
        sku,
        units: item.quantity,
        selling_price: unit,
        discount: 0,
        tax: item.gstRate != null ? item.gstRate : '',
        hsn: item.hsnCode || '',
        length,
        breadth,
        height,
        weight
      });
    }

    const addr = order.addressSnapshot || {};
    const billingPhone = String(addr.phone || '').replace(/\D/g, '').slice(-10) || '9999999999';

    const totalWeight = orderItems.reduce((s, it) => s + (Number(it.weight) || 0.5) * (Number(it.units) || 1), 0);
    const maxL = Math.max(10, ...orderItems.map((i) => Number(i.length) || 0));
    const maxB = Math.max(10, ...orderItems.map((i) => Number(i.breadth) || 0));
    const maxH = Math.max(10, ...orderItems.map((i) => Number(i.height) || 0));

    const payload = {
      order_id: order.orderId,
      order_date: (order.createdAt || new Date()).toISOString().slice(0, 19).replace('T', ' '),
      pickup_location: pickupLocation,
      billing_customer_name: addr.fullName || 'Customer',
      billing_last_name: '.',
      billing_address: addr.addressLine1 || 'Address',
      billing_address_2: addr.addressLine2 || '',
      billing_city: addr.city || '',
      billing_pincode: String(addr.postalCode || '').replace(/\D/g, '').slice(0, 6),
      billing_state: addr.state || '',
      billing_country: addr.country || 'India',
      billing_email: process.env.STORE_EMAIL || 'orders@example.com',
      billing_phone: billingPhone,
      shipping_is_billing: true,
      order_items: orderItems.map((it) => ({
        name: it.name,
        sku: it.sku,
        units: it.units,
        selling_price: it.selling_price,
        discount: it.discount,
        tax: it.tax,
        hsn: it.hsn
      })),
      payment_method: order.paymentInfo?.method === 'cod' ? 'COD' : 'Prepaid',
      sub_total: Number(order.subtotal) || 0,
      length: maxL,
      breadth: maxB,
      height: maxH,
      weight: Math.max(0.05, totalWeight)
    };

    try {
      const { data } = await axios.post(`${this.baseURL}/external/orders/create/adhoc`, payload, {
        timeout: 30000,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      return {
        success: true,
        shipmentId: data.shipment_id,
        trackingNumber: data.awb_code || data.tracking_number,
        courier: data.courier_name,
        labelUrl: data.label_url,
        mock: false
      };
    } catch (err) {
      console.error('[Shiprocket] createShipment failed:', err.response?.data || err.message);
      return { success: false, error: err.response?.data || err.message };
    }
  }
}

module.exports = new ShiprocketService();
