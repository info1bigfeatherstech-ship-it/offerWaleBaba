// controllers/deliveryController.js

// Mock serviceable pincodes (you can expand this list)
const SERVICEABLE_PINCODES = [
  '560001', '560002', '560003', // Bangalore
  '400001', '400002', '400003', // Mumbai
  '110001', '110002', '110003', // Delhi
  '500001', '500002', '500003', // Hyderabad
  '600001', '600002', '600003'  // Chennai
];

// Mock delivery charges based on pincode
const getDeliveryCharge = (pincode) => {
  // Free delivery for certain pincodes
  const freeDeliveryPincodes = ['560001', '400001', '110001'];
  
  if (freeDeliveryPincodes.includes(pincode)) {
    return 0;
  }
  
  // Distance-based calculation (mock)
  if (pincode.startsWith('56')) return 40; // Bangalore region
  if (pincode.startsWith('40')) return 50; // Mumbai region
  if (pincode.startsWith('11')) return 45; // Delhi region
  return 60; // Default charge
};

// Check delivery availability
const checkDeliveryAvailability = async (req, res) => {
  try {
    const { pincode, cartItems, userType } = req.body;

    // Validate pincode
    if (!pincode) {
      return res.status(400).json({
        success: false,
        message: "Pincode is required"
      });
    }

    const pincodeRegex = /^[0-9]{6}$/;
    if (!pincodeRegex.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid 6-digit pincode"
      });
    }

    // Check if pincode is serviceable
    const isServiceable = SERVICEABLE_PINCODES.includes(pincode);

    if (!isServiceable) {
      return res.status(200).json({
        success: true,
        isDeliverable: false,
        message: "Delivery not available at this pincode yet",
        deliveryCharges: 0,
        estimatedDays: null
      });
    }

    // Calculate delivery charges
    const deliveryCharges = getDeliveryCharge(pincode);

    // Calculate estimated days (mock logic)
    let estimatedDays = "3-5";
    if (deliveryCharges === 0) {
      estimatedDays = "2-3"; // Free delivery = faster? (mock)
    }

    // Optional: Check if any product has restrictions
    let productRestrictions = [];
    if (cartItems && cartItems.length > 0) {
      // You can add product-specific delivery checks here
      // For example: fragile items, heavy items, etc.
    }

    return res.status(200).json({
      success: true,
      isDeliverable: true,
      deliveryCharges: deliveryCharges,
      estimatedDays: estimatedDays,
      message: "Delivery available",
      pincode: pincode,
      productRestrictions: productRestrictions
    });

  } catch (error) {
    console.error("Delivery check error:", error);
    return res.status(500).json({
      success: false,
      message: "Error checking delivery availability",
      error: error.message
    });
  }
};

// Get delivery charges for a pincode (simple version)
const getDeliveryCharges = async (req, res) => {
  try {
    const { pincode } = req.params;

    if (!pincode) {
      return res.status(400).json({
        success: false,
        message: "Pincode is required"
      });
    }

    const isServiceable = SERVICEABLE_PINCODES.includes(pincode);
    
    if (!isServiceable) {
      return res.status(200).json({
        success: true,
        isServiceable: false,
        deliveryCharges: null,
        message: "Delivery not available"
      });
    }

    const deliveryCharges = getDeliveryCharge(pincode);

    return res.status(200).json({
      success: true,
      isServiceable: true,
      deliveryCharges: deliveryCharges,
      estimatedDays: "3-5",
      message: "Delivery available"
    });

  } catch (error) {
    console.error("Get delivery charges error:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching delivery charges",
      error: error.message
    });
  }
};

module.exports = {
  checkDeliveryAvailability,
  getDeliveryCharges
};