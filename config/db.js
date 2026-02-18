// require('dotenv').config();
// const mongoose = require('mongoose');
// const dns = require('dns');
// dns.setDefaultResultOrder('ipv4first');

// async function testConnection() {
//   try {
//     const url='mongodb+srv://info1bigfeatherstech_db_user:tech12345@cluster0.reukicg.mongodb.net/?appName=Cluster0'
//     console.log('Connecting to:', url.replace(/:[^:]*@/, ':****@'));
//     await mongoose.connect(url, {
//       serverSelectionTimeoutMS: 5000,
//       connectTimeoutMS: 10000,
//     });
//     console.log('✅ Connected successfully!');
//     console.log('Database:', mongoose.connection.db.databaseName);
//     await mongoose.disconnect();
//   } catch (error) {
//     console.error('❌ Connection failed:', error.message);
//     console.error('Error name:', error.name);
//     console.error('Error code:', error.code);
//   }
// }

// testConnection();
// console.log(process.env.MONGO_DB_URI);


// const dbConfig=async()=>{
//     try {
//            await mongoose.connect("mongodb+srv://info1bigfeatherstech_db_user:tech12345@ac-vxidevl-shard-00-00.reukicg.mongodb.net:27017,ac-vxidevl-shard-00-01.reukicg.mongodb.net:27017,ac-vxidevl-shard-00-02.reukicg.mongodb.net:27017/offerwalebabadb?ssl=true&replicaSet=atlas-vxidevl-shard-0&authSource=admin&retryWrites=true&w=majority");
//     console.log("connected to db");
//     } catch (error) {
//         console.error("Error connecting to MongoDB:", error.message);
//     }
 
// }

// dbConfig();

// const { MongoClient } = require("mongodb");

// const uri = "mongodb://info1bigfeatherstech_db_user:tech12345@ac-vxidevl-shard-00-00.reukicg.mongodb.net:27017,ac-vxidevl-shard-00-01.reukicg.mongodb.net:27017,ac-vxidevl-shard-00-02.reukicg.mongodb.net:27017/?ssl=true&authSource=admin&retryWrites=true&w=majority";

// const client = new MongoClient(uri);

// async function run() {
//   try {
//     await client.connect();
//     console.log("✅ Connected successfully");
//   } catch (err) {
//     console.error("❌ Connection failed:", err);
//   }
// }

// run();
