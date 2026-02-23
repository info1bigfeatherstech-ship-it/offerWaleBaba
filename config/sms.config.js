const fast2sms = require("../providers/fast2sms.provider");
const twilio = require("../providers/twilio.provider");

const provider = process.env.SMS_PROVIDER;
console.log("Loading SMS Provider:", provider);
let smsProvider;

if (provider === "twilio") {
  smsProvider = twilio;
} else {
  smsProvider = fast2sms;
}

module.exports = smsProvider;