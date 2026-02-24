const mongoose = require('mongoose');

const raceInviteSchema = new mongoose.Schema({
  race: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Race',
    required: true,
  },
  fromUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  toUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'expired'],
    default: 'pending',
  },
  respondedAt: {
    type: Date,
  },
}, {
  timestamps: true,
});

raceInviteSchema.index({ race: 1, fromUser: 1, toUser: 1, status: 1 });

module.exports = mongoose.model('RaceInvite', raceInviteSchema);
