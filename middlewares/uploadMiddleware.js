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
const path   = require('path');
const fs     = require('fs');

// Ensure uploads dir exists
const UPLOAD_DIR = 'uploads/';
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ===============================
// IMAGE UPLOAD (for products) — UNCHANGED
// ===============================
const imageStorage = multer.memoryStorage();

const imageFileFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only jpeg, jpg, png, webp images are allowed'), false);
  }
};

const imageUpload = multer({
  storage   : imageStorage,
  fileFilter: imageFileFilter,
  limits    : { fileSize: 10 * 1024 * 1024 },
});

const uploadProductImages = imageUpload.any();
const uploadSingleImage   = imageUpload.single('image');

// ===============================
// SHARED DISK STORAGE (CSV + ZIP both use disk)
// ===============================
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename   : (req, file, cb) => {
    // sanitise original name so no spaces / special chars in path
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

// ===============================
// CSV / EXCEL UPLOAD — field name: "csvFile"
// Max 10MB — spreadsheets never need more
// ===============================
const csvFileFilter = (req, file, cb) => {
  const allowedMimes = [
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream', // some browsers send xlsx as this
  ];
  const ext      = path.extname(file.originalname).toLowerCase();
  const validExt = ['.csv', '.xls', '.xlsx'].includes(ext);

  if (allowedMimes.includes(file.mimetype) || validExt) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV or Excel files are allowed'), false);
  }
};

// Wrap in a middleware function so multer errors return clean JSON
// instead of Express default HTML error page
const _csvUpload = multer({
  storage   : diskStorage,
  fileFilter: csvFileFilter,
  limits    : { fileSize: 10 * 1024 * 1024 },
}).single('csvFile');

const uploadCSVFile = (req, res, next) => {
  _csvUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: 'CSV/Excel file too large. Maximum size is 10MB.',
      });
    }
    return res.status(400).json({ success: false, message: err.message });
  });
};

// ===============================
// ZIP UPLOAD — field name: "zipFile"
// Max 500MB — 100 products × 5 images × ~1MB each
// ===============================
const zipFileFilter = (req, file, cb) => {
  const allowedMimes = [
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream',
    'multipart/x-zip',
  ];
  const ext      = path.extname(file.originalname).toLowerCase();
  const validExt = ['.zip'].includes(ext);

  if (allowedMimes.includes(file.mimetype) || validExt) {
    cb(null, true);
  } else {
    cb(new Error('Only ZIP files are allowed'), false);
  }
};

const _zipUpload = multer({
  storage   : diskStorage,
  fileFilter: zipFileFilter,
  limits    : { fileSize: 500 * 1024 * 1024 }, // 500 MB
}).single('zipFile');

const uploadZIPFile = (req, res, next) => {
  _zipUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success : false,
        message : 'ZIP file too large. Maximum size is 500MB. Split into smaller batches.',
      });
    }
    return res.status(400).json({ success: false, message: err.message });
  });
};

module.exports = {
  uploadProductImages,
  uploadSingleImage,
  uploadCSVFile,   // Step 1 — CSV/Excel preview
  uploadZIPFile,   // Step 2 — ZIP image import
};
//  uploadMiddleWare.js  file here 

// const multer = require('multer');


// // ===============================
// // IMAGE UPLOAD (for products)
// // ===============================
// const imageStorage = multer.memoryStorage();

// const imageFileFilter = (req, file, cb) => {
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

// const imageUpload = multer({
//   storage: imageStorage,
//   fileFilter: imageFileFilter,
//   limits: { fileSize: 10 * 1024 * 1024 }
// });

// const uploadProductImages = imageUpload.any();
// const uploadSingleImage = imageUpload.single('image');


// // ===============================
// // CSV / EXCEL UPLOAD (NEW)
// // ===============================
// const csvStorage = multer.diskStorage({
//   destination: function (req, file, cb) {
//     cb(null, 'uploads/');
//   },
//   filename: function (req, file, cb) {
//     cb(null, Date.now() + '-' + file.originalname);
//   }
// });

// const csvFileFilter = (req, file, cb) => {
//   const allowedMimes = [
//     'text/csv',
//     'application/vnd.ms-excel',
//     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
//   ];

//   if (allowedMimes.includes(file.mimetype)) {
//     cb(null, true);
//   } else {
//     cb(new Error('Only CSV or Excel files are allowed'), false);
//   }
// };

// const csvUpload = multer({
//   storage: csvStorage,
//   fileFilter: csvFileFilter,
//   limits: { fileSize: 10 * 1024 * 1024 }
// });

// const uploadCSVFile = csvUpload.single('csvFile');
// // const uploadCSVFile = csvUpload.single('file');


// module.exports = {
//   uploadProductImages,
//   uploadSingleImage,
//   uploadCSVFile
// };



