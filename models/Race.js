const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  joinedAt: {
    type: Date,
    default: Date.now
  },
  dailyDistances: [{
    date: {
      type: Date,
      required: true
    },
    distance: {
      type: Number,
      default: 0,
      min: 0
    }
  }],
  totalDistance: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'withdrawn'],
    default: 'active'
  },
  completedAt: {
    type: Date
  }
});

const raceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Race name is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  imageUrl: {
    type: String,
    trim: true
  },
  startPoint: {
    latitude: {
      type: Number,
      required: true
    },
    longitude: {
      type: Number,
      required: true
    },
    address: {
      type: String
    }
  },
  endPoint: {
    latitude: {
      type: Number,
      required: true
    },
    longitude: {
      type: Number,
      required: true
    },
    address: {
      type: String
    }
  },
  // Google Directions overview polyline (encoded). Stored once, reused by clients.
  routePolyline: {
    type: String,
    trim: true
  },
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    required: true,
    validate: {
      validator: function(value) {
        return value > this.startDate;
      },
      message: 'End date must be after start date'
    }
  },
  participants: [participantSchema],
  status: {
    type: String,
    enum: ['upcoming', 'active', 'completed'],
    default: 'upcoming'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Update status based on dates
raceSchema.pre('save', function(next) {
  const now = new Date();
  if (now < this.startDate) {
    this.status = 'upcoming';
  } else if (now >= this.startDate && now <= this.endDate) {
    this.status = 'active';
  } else {
    this.status = 'completed';
  }
  next();
});

// Method to add participant
raceSchema.methods.addParticipant = function(userId) {
  const existingParticipant = this.participants.find(
    p => p.user.toString() === userId.toString()
  );
  
  if (existingParticipant) {
    throw new Error('User is already a participant');
  }
  
  this.participants.push({
    user: userId,
    dailyDistances: [],
    totalDistance: 0,
    status: 'active'
  });
  
  return this.save();
};

// Method to update daily distance
raceSchema.methods.updateDailyDistance = function(userId, date, distance) {
  const participant = this.participants.find(
    p => p.user.toString() === userId.toString()
  );
  
  if (!participant) {
    throw new Error('User is not a participant');
  }
  
  // Find or create daily distance entry
  const dateStr = new Date(date).toISOString().split('T')[0];
  const dailyEntry = participant.dailyDistances.find(
    d => new Date(d.date).toISOString().split('T')[0] === dateStr
  );
  
  if (dailyEntry) {
    // Update existing entry
    const oldDistance = dailyEntry.distance;
    dailyEntry.distance = distance;
    participant.totalDistance = participant.totalDistance - oldDistance + distance;
  } else {
    // Add new entry
    participant.dailyDistances.push({
      date: new Date(date),
      distance: distance
    });
    participant.totalDistance += distance;
  }
  
  // Check if participant completed the race
  const raceDistance = this.calculateRaceDistance();
  if (participant.totalDistance >= raceDistance && participant.status === 'active') {
    participant.status = 'completed';
    participant.completedAt = new Date();
  }
  
  return this.save();
};

// Method to calculate race distance (straight line distance)
raceSchema.methods.calculateRaceDistance = function() {
  const R = 6371; // Earth's radius in km
  const lat1 = this.startPoint.latitude * Math.PI / 180;
  const lat2 = this.endPoint.latitude * Math.PI / 180;
  const deltaLat = (this.endPoint.latitude - this.startPoint.latitude) * Math.PI / 180;
  const deltaLng = (this.endPoint.longitude - this.startPoint.longitude) * Math.PI / 180;
  
  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return R * c; // Distance in km
};

module.exports = mongoose.model('Race', raceSchema);
