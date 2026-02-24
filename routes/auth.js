const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const uploadToS3 = require('../utils/awsUpload');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const XP_PER_KM = 10;

function sanitizeNicknameSeed(seed) {
  const cleaned = String(seed || '')
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '');
  return cleaned.length >= 3 ? cleaned.slice(0, 24) : 'runner';
}

async function generateUniqueNickname(seed) {
  const base = sanitizeNicknameSeed(seed);
  let candidate = base;
  let suffix = 0;

  while (suffix < 5000) {
    const exists = await User.findOne({ nickname: candidate });
    if (!exists) return candidate;
    suffix += 1;
    candidate = `${base}${suffix}`.slice(0, 24);
  }

  return `${base}${Date.now().toString().slice(-4)}`.slice(0, 24);
}

function xpForLevel(level) {
  if (level <= 1) return 0;
  return Math.floor(100 * Math.pow(level - 1, 1.5));
}

function levelFromXp(totalXp) {
  let level = 1;
  while (totalXp >= xpForLevel(level + 1)) {
    level += 1;
  }
  return level;
}

function progressionFromUser(user) {
  const totalXp = Number(user.totalXp || 0);
  const level = Number(user.level || levelFromXp(totalXp));
  const currentLevelXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  const needed = Math.max(1, nextLevelXp - currentLevelXp);
  const inLevelXp = totalXp - currentLevelXp;

  return {
    level,
    totalXp,
    totalKmLifetime: Number((user.totalKmLifetime || 0).toFixed(2)),
    xpPerKm: XP_PER_KM,
    currentLevelXp,
    nextLevelXp,
    inLevelXp,
    xpToNextLevel: Math.max(0, nextLevelXp - totalXp),
    progress: Number((inLevelXp / needed).toFixed(4)),
  };
}

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
};

// Register new user
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').optional().trim(),
  body('nickname')
    .trim()
    .isLength({ min: 3, max: 24 })
    .matches(/^[a-z0-9._]+$/)
], async (req, res) => {
  const startTime = Date.now();
  const clientIp = req.ip || req.connection.remoteAddress;
  
  try {
    console.log('\n=== REGISTRATION ATTEMPT ===');
    console.log(`[${new Date().toISOString()}] IP: ${clientIp}`);
    console.log(`Email: ${req.body.email}`);
    console.log(`Name: ${req.body.name || 'Not provided'}`);
    
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ Validation failed:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name, nickname } = req.body;

    // Check if user already exists
    console.log(`🔍 Checking if user exists: ${email}`);
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.log(`❌ User already exists: ${email}`);
      return res.status(400).json({ message: 'User already exists with this email' });
    }
    console.log(`✅ Email available: ${email}`);

    const existingNickname = await User.findOne({ nickname: nickname.toLowerCase() });
    if (existingNickname) {
      return res.status(400).json({ message: 'Nickname already in use' });
    }

    // Create new user
    console.log(`📝 Creating new user: ${email}`);
    const user = new User({
      email,
      password,
      name: name || '',
      nickname: nickname.toLowerCase()
    });

    await user.save();
    console.log(`✅ User created successfully!`);
    console.log(`   User ID: ${user._id}`);
    console.log(`   Email: ${user.email}`);
    console.log(`   Name: ${user.name || 'Not set'}`);

    // Generate token
    const token = generateToken(user._id);
    console.log(`🔑 Token generated for user: ${user._id}`);

    const duration = Date.now() - startTime;
    console.log(`⏱️  Registration completed in ${duration}ms`);
    console.log('=== REGISTRATION SUCCESS ===\n');

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl
      }
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ Registration error:', error);
    console.error(`⏱️  Failed after ${duration}ms`);
    console.log('=== REGISTRATION FAILED ===\n');
    res.status(500).json({ message: 'Server error during registration', error: error.message });
  }
});

// Login user
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  const startTime = Date.now();
  const clientIp = req.ip || req.connection.remoteAddress;
  
  try {
    console.log('\n=== LOGIN ATTEMPT ===');
    console.log(`[${new Date().toISOString()}] IP: ${clientIp}`);
    console.log(`Email: ${req.body.email}`);
    
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ Validation failed:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Find user
    console.log(`🔍 Looking up user: ${email}`);
    const user = await User.findOne({ email });
    if (!user) {
      console.log(`❌ User not found: ${email}`);
      console.log('=== LOGIN FAILED ===\n');
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    console.log(`✅ User found: ${user._id}`);

    // Check password
    console.log(`🔐 Verifying password...`);
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      console.log(`❌ Invalid password for user: ${email}`);
      console.log('=== LOGIN FAILED ===\n');
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    console.log(`✅ Password verified`);

    let shouldSaveUser = false;
    if (!user.nickname) {
      user.nickname = await generateUniqueNickname(user.email?.split('@')[0]);
      shouldSaveUser = true;
    }
    const safeKm = Number(user.totalKmLifetime || 0);
    const safeXp = Number(user.totalXp || 0);
    const safeLevel = Number(user.level || levelFromXp(safeXp));
    if (user.totalKmLifetime !== safeKm) {
      user.totalKmLifetime = safeKm;
      shouldSaveUser = true;
    }
    if (user.totalXp !== safeXp) {
      user.totalXp = safeXp;
      shouldSaveUser = true;
    }
    if (user.level !== safeLevel) {
      user.level = safeLevel;
      shouldSaveUser = true;
    }
    if (shouldSaveUser) await user.save();

    // Generate token
    const token = generateToken(user._id);
    console.log(`🔑 Token generated for user: ${user._id}`);

    const duration = Date.now() - startTime;
    console.log(`⏱️  Login completed in ${duration}ms`);
    console.log(`✅ Login successful for: ${user.email}`);
    console.log('=== LOGIN SUCCESS ===\n');

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl
      }
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ Login error:', error);
    console.error(`⏱️  Failed after ${duration}ms`);
    console.log('=== LOGIN FAILED ===\n');
    res.status(500).json({ message: 'Server error during login', error: error.message });
  }
});

// Get current user (protected route)
router.get('/me', authMiddleware, async (req, res) => {
  try {
    console.log(`\n🔍 [GET /me] User ID: ${req.userId}`);
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      console.log(`❌ User not found: ${req.userId}`);
      return res.status(404).json({ message: 'User not found' });
    }
    console.log(`✅ User retrieved: ${user.email}`);
    res.json({ user });
  } catch (error) {
    console.error('❌ Get user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get progression (protected route)
// Also syncs XP if totalKmLifetime > 0 but totalXp is 0 (fixes users who had km before XP logic)
router.get('/progression', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select(
      'totalKmLifetime totalXp level',
    );
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const totalKm = Number(user.totalKmLifetime || 0);
    const currentXp = Number(user.totalXp || 0);
    const expectedXp = Math.floor(totalKm * XP_PER_KM);

    if (totalKm > 0 && currentXp < expectedXp) {
      user.totalXp = expectedXp;
      user.level = levelFromXp(expectedXp);
      await user.save();
      console.log(`[PROGRESSION] Synced XP for user ${req.userId}: ${currentXp} -> ${expectedXp} (from ${totalKm} km)`);
    }

    res.json({
      progression: progressionFromUser(user),
    });
  } catch (error) {
    console.error('Get progression error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update user profile (protected route)
router.put('/profile', authMiddleware, [
  body('name').optional().trim(),
  body('email').optional().isEmail().normalizeEmail(),
  body('nickname').optional().trim().isLength({ min: 3, max: 24 }).matches(/^[a-z0-9._]+$/)
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, nickname, avatar, mimeType } = req.body;
    const updateData = {};

    if (name) updateData.name = name;
    if (email) {
      // Check if email is already taken by another user
      const existingUser = await User.findOne({ email, _id: { $ne: req.userId } });
      if (existingUser) {
        return res.status(400).json({ message: 'Email already in use' });
      }
      updateData.email = email;
    }

    if (nickname) {
      const normalizedNickname = nickname.toLowerCase();
      const existingNickname = await User.findOne({
        nickname: normalizedNickname,
        _id: { $ne: req.userId },
      });
      if (existingNickname) {
        return res.status(400).json({ message: 'Nickname already in use' });
      }
      updateData.nickname = normalizedNickname;
    }

    if (avatar) {
      if (String(avatar).startsWith('http')) {
        updateData.avatarUrl = avatar;
      } else {
        try {
          updateData.avatarUrl = await uploadToS3(avatar, 'avatar', mimeType || '');
        } catch (err) {
          console.warn('⚠️  [AUTH] S3 avatar upload failed:', err?.message);
        }
      }
    }

    const user = await User.findByIdAndUpdate(
      req.userId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');

    res.json({
      message: 'Profile updated successfully',
      user
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Change password (protected route)
router.put('/change-password', authMiddleware, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.userId);

    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
