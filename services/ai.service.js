// const axios=require("axios");
// const buildPrompt=require("../utils/promptBuilder.js");
// const searchProducts=require("./product.service.js")

//  const processUserMessage = async (message) => {
//   const prompt = buildPrompt(message);

//   try {
// const response = await axios.post(
//   "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2",
//   {
//     model: "meta-llama/Llama-3-8b-instruct",
//     messages: [
//       {
//         role: "system",
//         content: "You are an AI assistant for an e-commerce website. Return JSON only."
//       },
//       {
//         role: "user",
//         content: prompt
//       }
//     ]
//   },
//   {
//     headers: {
//       Authorization: `Bearer ${process.env.HF_TOKEN}`,
//       "Content-Type": "application/json"
//     }
//   }
// );

//     const rawText = response.data?.[0]?.generated_text || "";

//     const jsonStart = rawText.indexOf("{");
//     const jsonEnd = rawText.lastIndexOf("}");

//     let parsedData;

//     try {
//       const jsonString = rawText.slice(jsonStart, jsonEnd + 1);
//       parsedData = JSON.parse(jsonString);
//     } catch {
//       parsedData = { intent: "unknown" };
//     }

//     // 🔥 🔥 MAIN LOGIC STARTS HERE 🔥 🔥

//     if (parsedData.intent === "search_product") {
//       const products = await searchProducts(parsedData.filters);

//       return {
//         type: "products",
//         data: products
//       };
//     }

//     // fallback
//     return {
//       type: "text",
//       data: rawText
//     };

//   } catch (error) {
//    console.error("FULL ERROR:", error.response?.data || error.message);

//   throw error; // 👈 original error throw karo
//   }
// };

// module.exports=processUserMessage;


const axios = require("axios");
const buildPrompt = require("../utils/promptBuilder.js");
const searchProducts = require("./product.service.js");

const processUserMessage = async (message) => {
  const prompt = buildPrompt(message);

  try {
    const response = await axios.post(
      "https://router.huggingface.co/v1/chat/completions",
      {
        model: "Qwen/Qwen2.5-72B-Instruct",  // ✅ Confirmed available on free tier
        messages: [
          {
            role: "system",
            content: "You are an AI assistant for an e-commerce website. Return JSON only. No explanation, no markdown, just raw JSON."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: 512,
        temperature: 0.1
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HF_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    const rawText = response.data?.choices?.[0]?.message?.content || "";

    let parsedData;
    try {
      const jsonStart = rawText.indexOf("{");
      const jsonEnd = rawText.lastIndexOf("}");
      const jsonString = rawText.slice(jsonStart, jsonEnd + 1);
      parsedData = JSON.parse(jsonString);
    } catch {
      parsedData = { intent: "unknown" };
    }

    if (parsedData.intent === "search_product") {
      const products = await searchProducts(parsedData.filters);
      return { type: "products", data: products };
    }

    return { type: "text", data: rawText };

  } catch (error) {
    console.error("FULL ERROR:", error.response?.data || error.message);
    throw error;
  }
};

module.exports = processUserMessage;