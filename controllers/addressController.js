const Address = require("../models/Address");

// Add a new address
const addAddress = async (req, res) => {
  try {
    const userId = req.userId;

    let {
      fullName,
      phone,
      houseNumber,
      area,
      landmark,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      country,
      addressType,
      isDefault,
      isGift,
      deliveryInstructions
    } = req.body;

    // =========================
    // 🔒 BASIC VALIDATION
    // =========================
    if (
      !fullName ||
      !phone ||
      !houseNumber ||
      !area ||
      !city ||
      !state ||
      !postalCode
    ) {
      return res.status(400).json({
        success: false,
        message: "Required address fields are missing"
      });
    }

    // =========================
    // 🧹 SANITIZATION
    // =========================
    const clean = (val) =>
      typeof val === "string" ? val.trim() : val;

    fullName = clean(fullName);
    phone = clean(phone);
    houseNumber = clean(houseNumber);
    area = clean(area);
    landmark = clean(landmark);
    addressLine1 = clean(addressLine1);
    addressLine2 = clean(addressLine2);
    city = clean(city);
    state = clean(state);
    postalCode = clean(postalCode);
    country = clean(country) || "India";

    // =========================
    // 🔍 DUPLICATE CHECK (SMART)
    // =========================
    const existingAddress = await Address.findOne({
      userId,
      fullName,
      phone,
      houseNumber,
      area,
      city,
      state,
      postalCode
    });

    if (existingAddress) {
      return res.status(200).json({
        success: true,
        message: "Address already exists",
        address: existingAddress
      });
    }

    // =========================
    // 🔒 DEFAULT ADDRESS LOGIC
    // =========================
    const addressCount = await Address.countDocuments({ userId });

    if (addressCount === 0) {
      // 🟢 FIRST ADDRESS → ALWAYS DEFAULT
      isDefault = true;
    } else if (isDefault === true || isDefault === "true") {
      // 🟡 USER WANTS THIS DEFAULT → REMOVE OLD
      await Address.updateMany(
        { userId },
        { $set: { isDefault: false } }
      );
      isDefault = true;
    } else {
      // 🔴 NORMAL CASE
      isDefault = false;
    }

    // =========================
    // 🏠 CREATE ADDRESS
    // =========================
    const address = new Address({
      userId,
      fullName,
      phone,
      houseNumber,
      area,
      landmark: landmark || "",
      addressLine1: addressLine1 || "",
      addressLine2: addressLine2 || "",
      city,
      state,
      postalCode,
      country,
      addressType: addressType || "home", // home | work | other
      isDefault,
      isGift: isGift || false,
      deliveryInstructions: deliveryInstructions || ""
    });

    await address.save();

    return res.status(201).json({
      success: true,
      message: "Address added successfully",
      address
    });

  } catch (error) {
    console.error("Add address error:", error);

    return res.status(500).json({
      success: false,
      message: "Error adding address",
      error: error.message
    });
  }
};


// Get all addresses for a user (PRO VERSION)
const getAddresses = async (req, res) => {
  try {
    const userId = req.userId;

    // =========================
    // 📦 FETCH ADDRESSES
    // =========================
    const addresses = await Address.find({ userId })
      .sort({ isDefault: -1, createdAt: -1 })
      .lean();

    // =========================
    // 🎯 FIND DEFAULT ADDRESS
    // =========================
    let defaultAddress = null;

    if (addresses.length > 0) {
      defaultAddress = addresses.find(addr => addr.isDefault) || null;
    }

    // =========================
    // 🧹 REMOVE DEFAULT FROM LIST (optional clean UX)
    // =========================
    const otherAddresses = addresses.filter(addr => !addr.isDefault);

    // =========================
    // 📊 RESPONSE
    // =========================
    return res.status(200).json({
      success: true,
      count: addresses.length,
      defaultAddress,
      addresses: otherAddresses
    });

  } catch (error) {
    console.error("Get addresses error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching addresses",
      error: error.message
    });
  }
};



// Update an address
const updateAddress = async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;

    let updates = { ...req.body };

    // =========================
    // 🔒 FIND ADDRESS (OWNERSHIP CHECK)
    // =========================
    const address = await Address.findOne({ _id: id, userId });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Address not found"
      });
    }

    // =========================
    // 🧹 SANITIZATION FUNCTION
    // =========================
    const clean = (val) =>
      typeof val === "string" ? val.trim() : val;

    // =========================
    // 🔒 VALIDATION (PARTIAL)
    // =========================
    if (updates.phone) {
      updates.phone = clean(updates.phone);
    }

    if (updates.postalCode) {
      updates.postalCode = clean(updates.postalCode);
    }

    if (updates.fullName) {
      updates.fullName = clean(updates.fullName);
    }

    if (updates.houseNumber) {
      updates.houseNumber = clean(updates.houseNumber);
    }

    if (updates.area) {
      updates.area = clean(updates.area);
    }

    if (updates.city) {
      updates.city = clean(updates.city);
    }

    if (updates.state) {
      updates.state = clean(updates.state);
    }

    if (updates.addressLine1) {
      updates.addressLine1 = clean(updates.addressLine1);
    }

    if (updates.addressLine2) {
      updates.addressLine2 = clean(updates.addressLine2);
    }

    if (updates.landmark !== undefined) {
      updates.landmark = clean(updates.landmark);
    }

    if (updates.country) {
      updates.country = clean(updates.country);
    }

    // =========================
    // 🔒 DEFAULT ADDRESS LOGIC
    // =========================
    if (updates.isDefault === true || updates.isDefault === "true") {
      await Address.updateMany(
        { userId },
        { $set: { isDefault: false } }
      );

      updates.isDefault = true;
    }

    // =========================
    // 🛑 PREVENT EMPTY REQUIRED FIELDS
    // =========================
    const requiredFields = [
      "fullName",
      "phone",
      "houseNumber",
      "area",
      "city",
      "state",
      "postalCode"
    ];

    for (const field of requiredFields) {
      if (updates[field] !== undefined && updates[field] === "") {
        return res.status(400).json({
          success: false,
          message: `${field} cannot be empty`
        });
      }
    }

    // =========================
    // 🔁 APPLY UPDATES
    // =========================
    Object.keys(updates).forEach((key) => {
      address[key] = updates[key];
    });

    await address.save();

    return res.status(200).json({
      success: true,
      message: "Address updated successfully",
      address
    });

  } catch (error) {
    console.error("Update address error:", error);

    return res.status(500).json({
      success: false,
      message: "Error updating address",
      error: error.message
    });
  }
};


// Delete an address (PRO VERSION)
const deleteAddress = async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;

    // =========================
    // 🔒 FIND ADDRESS (OWNERSHIP CHECK)
    // =========================
    const address = await Address.findOne({ _id: id, userId });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Address not found"
      });
    }

    const isDefault = address.isDefault;

    // =========================
    // 🗑️ DELETE ADDRESS
    // =========================
    await Address.deleteOne({ _id: id, userId });

    // =========================
    // 🔁 DEFAULT FALLBACK LOGIC
    // =========================
    if (isDefault) {
      const nextAddress = await Address.findOne({ userId })
        .sort({ createdAt: -1 });

      if (nextAddress) {
        nextAddress.isDefault = true;
        await nextAddress.save();
      }
    }

    // =========================
    // 📊 RESPONSE
    // =========================
    return res.status(200).json({
      success: true,
      message: "Address deleted successfully"
    });

  } catch (error) {
    console.error("Delete address error:", error);

    return res.status(500).json({
      success: false,
      message: "Error deleting address",
      error: error.message
    });
  }
};


module.exports = { addAddress, getAddresses, updateAddress, deleteAddress };