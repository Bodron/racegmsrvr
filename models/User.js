const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  appleId: {
    type: String,
    unique: true,
    sparse: true,
    index: true,
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters']
  },
  name: {
    type: String,
    trim: true
  },
  nickname: {
    type: String,
    trim: true,
    lowercase: true,
    unique: true,
    sparse: true,
    minlength: [3, 'Nickname must be at least 3 characters'],
    maxlength: [24, 'Nickname must be at most 24 characters'],
    match: [/^[a-z0-9._]+$/, 'Nickname can contain only lowercase letters, numbers, dot and underscore']
  },
  avatarUrl: {
    type: String,
    trim: true
  },
  lastHealthSyncAt: {
    type: Date,
  },
  totalKmLifetime: {
    type: Number,
    default: 0,
    min: 0,
  },
  totalXp: {
    type: Number,
    default: 0,
    min: 0,
  },
  level: {
    type: Number,
    default: 1,
    min: 1,
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Remove password from JSON output
userSchema.methods.toJSON = function() {
  const userObject = this.toObject();
  delete userObject.password;
  return userObject;
};

module.exports = mongoose.model('User', userSchema);
