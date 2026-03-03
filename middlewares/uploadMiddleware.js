// const multer = require('multer');
// const path = require('path');

// // Configure multer for in-memory storage (will upload to Cloudinary)
// const storage = multer.memoryStorage();

// const fileFilter = (req, file, cb) => {
//   // Accept only image files
//   const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
//   if (allowedMimes.includes(file.mimetype)) {
//     cb(null, true);
//   } else {
//     cb(new Error('Only image files (jpeg, png, gif, webp) are allowed'), false);
//   }
// };

// const upload = multer({
//   storage,
//   fileFilter,
//   limits: { fileSize: 5 * 1024 * 1024 } // 5MB max per file
// });

// // Middleware to handle multiple image uploads (array field name: 'images')
// const uploadProductImages = upload.array('images', 10); // max 10 images per product

// module.exports = { uploadProductImages };


// const multer = require('multer');

// // In-memory storage (best for cloud uploads)
// const storage = multer.memoryStorage();

// const fileFilter = (req, file, cb) => {
//   const allowedMimes = [
//     'image/jpeg',
//     'image/png',
//     'image/webp',
//     'image/jpg'
//   ];

//   if (allowedMimes.includes(file.mimetype)) {
//     cb(null, true);
//   } else {
//     cb(new Error('Only jpeg, jpg, png, webp images are allowed'), false);
//   }
// };

// const upload = multer({
//   storage,
//   fileFilter,
//   limits: { fileSize: 10 * 1024 * 1024 } // 8MB max
// });





// const uploadProductImages = upload.any();
// const uploadSingleImage = upload.single('image');
// const uploadCSVFile = upload.single('csvFile');



const multer = require('multer');


// ===============================
// IMAGE UPLOAD (for products)
// ===============================
const imageStorage = multer.memoryStorage();

const imageFileFilter = (req, file, cb) => {
  const allowedMimes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/jpg'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only jpeg, jpg, png, webp images are allowed'), false);
  }
};

const imageUpload = multer({
  storage: imageStorage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const uploadProductImages = imageUpload.any();
const uploadSingleImage = imageUpload.single('image');


// ===============================
// CSV / EXCEL UPLOAD (NEW)
// ===============================
const csvStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const csvFileFilter = (req, file, cb) => {
  const allowedMimes = [
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV or Excel files are allowed'), false);
  }
};

const csvUpload = multer({
  storage: csvStorage,
  fileFilter: csvFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const uploadCSVFile = csvUpload.single('csvFile');


module.exports = {
  uploadProductImages,
  uploadSingleImage,
  uploadCSVFile
};



