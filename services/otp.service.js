const smsProvider = require("../config/sms.config");
const crypto = require("crypto");

exports.generateOTP = () => {
  return crypto.randomInt(100000, 999999).toString();
};

exports.sendOTP = async (phone, otp) => {
  // const message = `Your OTP is ${otp}. It expires in 5 minutes.`;

  await smsProvider.sendSMS(phone , otp);

  return otp;
};