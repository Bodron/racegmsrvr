const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

const authMiddleware = (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      console.log('🔒 [AUTH] No authorization header provided');
      return res.status(401).json({ message: 'No token provided' });
    }

    // Extract token (format: "Bearer <token>")
    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : authHeader;

    if (!token) {
      console.log('🔒 [AUTH] Token is empty');
      return res.status(401).json({ message: 'No token provided' });
    }

    // Verify token
    console.log(`🔒 [AUTH] Verifying token...`);
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    console.log(`✅ [AUTH] Token verified for user: ${decoded.userId}`);
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      console.log(`❌ [AUTH] Invalid token: ${error.message}`);
      return res.status(401).json({ message: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      console.log(`❌ [AUTH] Token expired`);
      return res.status(401).json({ message: 'Token expired' });
    }
    console.error(`❌ [AUTH] Error: ${error.message}`);
    return res.status(500).json({ message: 'Authentication error', error: error.message });
  }
};

module.exports = authMiddleware;
