const Address = require('../models/Address');
const cart = require('../models/cart');
const {
  computeCheckoutTotals,
  roundMoney2,
  cartFingerprintFromItems,
  evaluatecartForCheckout,
  resolveCouponDiscount,
  calculateTax
} = require('../services/checkoutComputation.service');

const QUOTE_TTL_MS = 48 * 60 * 60 * 1000;

const normalizePin = (p) => String(p || '').replace(/\D/g, '').slice(0, 6);

function allowDemoMockShipping(req) {
  if (req.body?.demoMockShipping !== true) return false;
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_CHECKOUT_DEMO_MOCK !== 'true') {
    return false;
  }
  return true;
}

/**
 * POST /api/checkout/quote
 * Server-authoritative totals; shipping folded into amountPayable (not a separate client line).
 * Body.demoMockShipping=true → random delivery + no Shiprocket (dev by default; prod only if ALLOW_CHECKOUT_DEMO_MOCK=true).
 */
exports.quoteCheckout = async (req, res) => {
  try {
    const userId = req.userId;
    const finalUserType = req.userType === 'wholesaler' ? 'wholesaler' : 'normal';
    const { addressId, couponCode, paymentMethodHint } = req.body || {};

    if (!addressId) {
      return res.status(400).json({ success: false, message: 'addressId is required' });
    }

    if (req.body?.demoMockShipping === true && !allowDemoMockShipping(req)) {
      return res.status(400).json({
        success: false,
        message: 'demoMockShipping is not enabled in this environment'
      });
    }

    const address = await Address.findById(addressId).lean();
    if (!address || String(address.userId) !== String(userId)) {
      return res.status(404).json({ success: false, message: 'Address not found' });
    }

    const pin = normalizePin(address.postalCode);
    if (pin.length !== 6) {
      return res.status(400).json({ success: false, message: 'Address must have a valid 6-digit postal code' });
    }

    const cart = await cart.findOne({ userId });
    if (!cart?.items?.length) {
      return res.status(400).json({ success: false, message: 'cart is empty' });
    }

    let finalTotals;

    if (allowDemoMockShipping(req)) {
      const evaluated = await evaluatecartForCheckout(cart, finalUserType, null);
      const { discount, appliedCouponCode } = await resolveCouponDiscount(
        couponCode,
        evaluated.subtotal,
        finalUserType,
        null,
        { consumeUsage: false }
      );
      const deliveryCharges = roundMoney2(35 + Math.floor(Math.random() * 56));
      const tax = calculateTax(evaluated.subtotal);
      const totalAmount = roundMoney2(evaluated.subtotal + deliveryCharges + tax - discount);
      finalTotals = {
        ...evaluated,
        discount,
        appliedCouponCode,
        deliveryCharges,
        tax,
        totalAmount,
        deliveryMeta: {
          estimatedDays: String(2 + Math.floor(Math.random() * 3)) + '–5',
          courierName: 'Demo courier (Shiprocket off)',
          isDeliverable: true,
          mock: true
        }
      };
    } else {
      const assumeCod = String(paymentMethodHint || '').toLowerCase() === 'cod';

      let last = await computeCheckoutTotals({
        cart,
        postalCode: pin,
        finalUserType,
        couponCode,
        session: null,
        consumeCoupon: false,
        codAmountForShiprocket: 0
      });

      if (assumeCod) {
        for (let i = 0; i < 2; i++) {
          const codVal = roundMoney2(last.subtotal + last.tax - last.discount + last.deliveryCharges);
          last = await computeCheckoutTotals({
            cart,
            postalCode: pin,
            finalUserType,
            couponCode,
            session: null,
            consumeCoupon: false,
            codAmountForShiprocket: codVal
          });
        }
      }

      finalTotals = last;
    }

    const fp = cartFingerprintFromItems(cart.items);
    cart.deliverySnapshot = {
      addressId,
      postalCode: pin,
      quotedAt: new Date(),
      cartFingerprint: fp,
      isDeliverable: true,
      deliveryCharges: finalTotals.deliveryCharges,
      estimatedDays: finalTotals.deliveryMeta?.estimatedDays,
      courierName: finalTotals.deliveryMeta?.courierName,
      weightKg: finalTotals.totalWeight,
      dims: finalTotals.dims,
      couponCodeUpper: couponCode ? String(couponCode).toUpperCase().trim() : '',
      ttlMs: QUOTE_TTL_MS,
      mockShipping: Boolean(allowDemoMockShipping(req))
    };
    await cart.save();

    const eta =
      finalTotals.deliveryMeta?.estimatedDays != null
        ? `Estimated delivery in ${finalTotals.deliveryMeta.estimatedDays} business days`
        : 'Delivery timeline will be confirmed after dispatch';

    return res.json({
      success: true,
      isDeliverable: true,
      deliveryEstimate: eta,
      courierName: finalTotals.deliveryMeta?.courierName || null,
      pincode: pin,
      itemCount: cart.items.length,
      itemsSubtotal: finalTotals.subtotal,
      promotionDiscount: finalTotals.discount,
      taxes: finalTotals.tax,
      amountPayable: finalTotals.totalAmount,
      includesShippingAndHandling: true,
      couponApplied: finalTotals.appliedCouponCode,
      quoteExpiresAt: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
      cartFingerprint: fp,
      demoMockShipping: Boolean(allowDemoMockShipping(req))
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        message: err.message,
        code: err.code
      });
    }
    console.error('quoteCheckout:', err);
    return res.status(500).json({ success: false, message: 'Failed to build checkout quote' });
  }
};
