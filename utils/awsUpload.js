const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

const bucketName = process.env.S3_BUCKET_NAME;

const s3Client = bucketName
  ? new S3Client({
      region: process.env.S3_REGION,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    })
  : null;

/**
 * Optimizes an image buffer using Sharp library.
 * Reduces file size while maintaining good quality.
 *
 * @param {Buffer} imageBuffer - The image buffer to optimize.
 * @param {string} mimeType - The MIME type of the image.
 * @param {string} filename - Optional filename hint (e.g., 'race', 'avatar') for optimization level.
 * @returns {Promise<{buffer: Buffer, contentType: string}>} Optimized buffer and content type.
 */
const optimizeImage = async (imageBuffer, mimeType, filename = '') => {
  try {
    const isImage = mimeType.startsWith('image/');
    if (!isImage) {
      return { buffer: imageBuffer, contentType: mimeType };
    }

    const isAvatar = filename.toLowerCase().includes('avatar');

    const MAX_WIDTH = isAvatar ? 800 : 1920;
    const MAX_HEIGHT = isAvatar ? 800 : 1920;

    const JPEG_QUALITY = isAvatar ? 75 : 80;
    const PNG_QUALITY = isAvatar ? 70 : 75;

    const metadata = await sharp(imageBuffer).metadata();
    const { width, height, format } = metadata;

    const needsResize = width > MAX_WIDTH || height > MAX_HEIGHT;

    let sharpInstance = sharp(imageBuffer).rotate();

    if (needsResize) {
      sharpInstance = sharpInstance.resize(MAX_WIDTH, MAX_HEIGHT, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    let optimizedBuffer;
    let optimizedContentType = 'image/jpeg';

    if (
      format === 'heic' ||
      format === 'heif' ||
      mimeType.includes('heic') ||
      mimeType.includes('heif')
    ) {
      try {
        optimizedBuffer = await sharpInstance
          .jpeg({
            quality: JPEG_QUALITY,
            progressive: true,
            mozjpeg: true,
          })
          .toBuffer();
        optimizedContentType = 'image/jpeg';
      } catch (heicError) {
        optimizedBuffer = await sharpInstance
          .webp({ quality: JPEG_QUALITY, effort: 6 })
          .toBuffer();
        optimizedContentType = 'image/webp';
      }
    } else if (format === 'jpeg' || format === 'jpg') {
      optimizedBuffer = await sharpInstance
        .jpeg({
          quality: JPEG_QUALITY,
          progressive: true,
          mozjpeg: true,
        })
        .toBuffer();
      optimizedContentType = 'image/jpeg';
    } else if (format === 'png') {
      try {
        const hasAlpha = metadata.hasAlpha;
        if (hasAlpha) {
          optimizedBuffer = await sharpInstance
            .png({
              quality: PNG_QUALITY,
              compressionLevel: 9,
              adaptiveFiltering: true,
            })
            .toBuffer();
          optimizedContentType = 'image/png';
        } else {
          optimizedBuffer = await sharpInstance
            .jpeg({
              quality: JPEG_QUALITY,
              progressive: true,
              mozjpeg: true,
            })
            .toBuffer();
          optimizedContentType = 'image/jpeg';
        }
      } catch (pngError) {
        optimizedBuffer = await sharpInstance
          .png({
            quality: PNG_QUALITY,
            compressionLevel: 9,
            adaptiveFiltering: true,
          })
          .toBuffer();
        optimizedContentType = 'image/png';
      }
    } else if (format === 'webp') {
      optimizedBuffer = await sharpInstance
        .webp({ quality: JPEG_QUALITY, effort: 6 })
        .toBuffer();
      optimizedContentType = 'image/webp';
    } else {
      try {
        optimizedBuffer = await sharpInstance
          .jpeg({
            quality: JPEG_QUALITY,
            progressive: true,
            mozjpeg: true,
          })
          .toBuffer();
        optimizedContentType = 'image/jpeg';
      } catch (conversionError) {
        try {
          optimizedBuffer = await sharpInstance
            .webp({ quality: JPEG_QUALITY, effort: 6 })
            .toBuffer();
          optimizedContentType = 'image/webp';
        } catch (webpError) {
          return { buffer: imageBuffer, contentType: mimeType };
        }
      }
    }

    return { buffer: optimizedBuffer, contentType: optimizedContentType };
  } catch (error) {
    console.warn('[S3] Image optimization failed, using original:', error.message);
    return { buffer: imageBuffer, contentType: mimeType };
  }
};

/**
 * Uploads data to AWS S3.
 * Supports Buffer, base64 string, or data URI.
 *
 * @param {Buffer|string} data - The data to upload (Buffer or base64 string).
 * @param {string} filename - Filename hint (e.g., 'race', 'avatar').
 * @param {string} mimeType - The MIME type of the file.
 * @returns {Promise<string>} The S3 file URL.
 */
const uploadToS3 = async (data, filename = '', mimeType = '') => {
  if (!s3Client || !bucketName) {
    throw new Error(
      'S3 not configured. Set S3_BUCKET_NAME, S3_REGION, S3_ACCESS_KEY, S3_SECRET_ACCESS_KEY in .env'
    );
  }

  try {
    let buffer;
    let contentType;

    if (Buffer.isBuffer(data)) {
      buffer = data;
      contentType = mimeType || 'application/octet-stream';
    } else if (typeof data === 'string') {
      if (data.startsWith('data:')) {
        const re = /^data:(.*?);base64,(.*)$/;
        const matches = data.match(re);
        if (!matches) throw new Error('Invalid base64 data format');
        const extractedMime = (matches[1] || '').trim();
        contentType = extractedMime || mimeType || 'application/octet-stream';
        buffer = Buffer.from(matches[2], 'base64');
      } else if (/^[A-Za-z0-9+/=\s]+$/.test(data.trim())) {
        buffer = Buffer.from(data.replace(/\s+/g, ''), 'base64');
        contentType = mimeType || 'application/octet-stream';
      } else {
        buffer = Buffer.from(data, 'utf-8');
        contentType = mimeType || 'text/plain';
      }
    } else {
      throw new Error('Unsupported data type');
    }

    const { buffer: optimizedBuffer, contentType: optimizedContentType } =
      await optimizeImage(buffer, contentType, filename);

    const fileExtension =
      mime.extension(optimizedContentType) ||
      mime.extension(contentType) ||
      'bin';
    const newFilename = `${uuidv4()}-${Date.now()}.${fileExtension}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: newFilename,
      Body: optimizedBuffer,
      ACL: 'public-read',
      ContentType: optimizedContentType,
    });

    await s3Client.send(command);

    return `https://${bucketName}.s3.amazonaws.com/${newFilename}`;
  } catch (error) {
    console.error('Error uploading to S3:', error);
    throw new Error('Upload failed');
  }
};

module.exports = uploadToS3;

/**
 * Deletes an object from S3 given a full URL or key.
 */
module.exports.deleteFromS3 = async (urlOrKey) => {
  if (!s3Client || !bucketName) return false;
  try {
    if (!urlOrKey) return false;
    let key = String(urlOrKey);
    if (key.startsWith('http')) {
      const u = new URL(key);
      key = u.pathname.replace(/^\//, '');
    }
    if (!key) return false;
    const cmd = new DeleteObjectCommand({ Bucket: bucketName, Key: key });
    await s3Client.send(cmd);
    return true;
  } catch (err) {
    console.warn('S3 delete failed:', err?.message || err);
    return false;
  }
};
