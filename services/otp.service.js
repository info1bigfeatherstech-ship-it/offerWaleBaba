const smsProvider = require("../config/sms.config");
const crypto = require("crypto");

exports.generateOTP = () => {
  return crypto.randomInt(100000, 999999).toString();
};
console.log("OTP SERVICE FILE LOADED");

exports.sendOTP = async (phone) => {
    console.log("sendOTP FUNCTION CALLED WITH PHONE:");
  const otp = crypto.randomInt(100000, 999999).toString();

  const message = `Your OTP is ${otp}. It expires in 5 minutes.`;
  console.log("Generated OTP:", otp);
  
  await smsProvider.sendSMS(phone, message);

  return otp;
};