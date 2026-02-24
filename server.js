const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const raceRoutes = require('./routes/races');
const socialRoutes = require('./routes/social');

const app = express();

// Middleware - increased limits for base64 image uploads (e.g. to S3)
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.originalUrl;
  const ip = req.ip || req.connection.remoteAddress;
  
  console.log(`\n📥 [${timestamp}] ${method} ${url} - IP: ${ip}`);
  
  // Log request body for POST/PUT requests (except passwords)
  if ((method === 'POST' || method === 'PUT') && req.body) {
    const logBody = { ...req.body };
    if (logBody.password) {
      logBody.password = '***HIDDEN***';
    }
    console.log(`📦 Body:`, JSON.stringify(logBody, null, 2));
  }
  
  // Log response when it finishes
  const originalSend = res.send;
  res.send = function(data) {
    console.log(`📤 [${timestamp}] ${method} ${url} - Status: ${res.statusCode}`);
    return originalSend.call(this, data);
  };
  
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/races', raceRoutes);
app.use('/api/social', socialRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Connect to MongoDB
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/racegm';

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('\n✅ Connected to MongoDB');
    console.log(`📊 Database: ${MONGODB_URI.split('/').pop()}`);
    app.listen(PORT, () => {
      console.log(`\n🚀 Server is running on port ${PORT}`);
      console.log(`🌐 API Base URL: http://localhost:${PORT}/api`);
      console.log(`📝 Health check: http://localhost:${PORT}/api/health`);
      console.log(`\n📋 Available endpoints:`);
      console.log(`\n🔐 Auth:`);
      console.log(`   POST   /api/auth/register`);
      console.log(`   POST   /api/auth/login`);
      console.log(`   GET    /api/auth/me`);
      console.log(`   GET    /api/auth/progression`);
      console.log(`   PUT    /api/auth/profile`);
      console.log(`   PUT    /api/auth/change-password`);
      console.log(`\n🤝 Social:`);
      console.log(`   GET    /api/social/users/search?nickname=<q>`);
      console.log(`   POST   /api/social/friends/request`);
      console.log(`   GET    /api/social/friends`);
      console.log(`   GET    /api/social/friends/requests`);
      console.log(`   POST   /api/social/friends/requests/:id/respond`);
      console.log(`   POST   /api/social/races/:raceId/invites`);
      console.log(`   GET    /api/social/race-invites`);
      console.log(`   POST   /api/social/race-invites/:id/respond`);
      console.log(`\n🏁 Races:`);
      console.log(`   GET    /api/races`);
      console.log(`   GET    /api/races/my-stats`);
      console.log(`   GET    /api/races/:id`);
      console.log(`   POST   /api/races`);
      console.log(`   POST   /api/races/:id/join`);
      console.log(`   PUT    /api/races/:id/distance`);
      console.log(`   GET    /api/races/:id/leaderboard`);
      console.log(`   PUT    /api/races/:id`);
      console.log(`   DELETE /api/races/:id`);
      console.log(`\n👀 Waiting for requests...\n`);
    });
  })
  .catch((error) => {
    console.error('\n❌ MongoDB connection error:', error);
    process.exit(1);
  });

module.exports = app;
