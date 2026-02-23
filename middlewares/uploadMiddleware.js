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


const multer = require('multer');

// In-memory storage (best for cloud uploads)
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
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

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024 } // 8MB max
});

const uploadCSV = multer({
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'text/csv') {
      cb(new Error('Only CSV files allowed'), false);
    }
    cb(null, true);
  }
});

const uploadProductImages = upload.array('images', 10);
const uploadSingleImage = upload.single('image');
const uploadCSVFile = uploadCSV.single('csvFile');


module.exports = { uploadProductImages, uploadSingleImage, uploadCSVFile };
