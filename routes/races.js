const express = require('express');
const { body, validationResult } = require('express-validator');
const Race = require('../models/Race');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const uploadToS3 = require('../utils/awsUpload');

const router = express.Router();
const XP_PER_KM = 10;

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

function progressionFromXp(totalXp) {
  const level = levelFromXp(totalXp);
  const currentLevelXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  const needed = Math.max(1, nextLevelXp - currentLevelXp);
  const inLevelXp = totalXp - currentLevelXp;
  return {
    level,
    totalXp,
    currentLevelXp,
    nextLevelXp,
    inLevelXp,
    xpToNextLevel: Math.max(0, nextLevelXp - totalXp),
    progress: Number((inLevelXp / needed).toFixed(4)),
  };
}

async function findOngoingParticipation(userId, excludeRaceId = null) {
  const now = new Date();
  const query = {
    endDate: { $gte: now },
    participants: {
      $elemMatch: {
        user: userId,
        status: { $ne: 'withdrawn' },
      },
    },
  };

  if (excludeRaceId) {
    query._id = { $ne: excludeRaceId };
  }

  return Race.findOne(query).select('_id name startDate endDate');
}

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

function requireGoogleKey() {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('Missing GOOGLE_MAPS_API_KEY in server environment');
  }
}

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = (data && data.message) ? data.message : `HTTP ${res.status}`;
      throw new Error(`Google API error: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function reverseGeocodePlaceName(lat, lng) {
  requireGoogleKey();
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`;
  const data = await fetchJsonWithTimeout(url, 7000);
  if (!data || data.status !== 'OK' || !Array.isArray(data.results) || data.results.length === 0) {
    return null;
  }
  const first = data.results[0];
  const components = Array.isArray(first.address_components) ? first.address_components : [];
  let locality = null;
  let sublocality = null;
  let admin2 = null;
  for (const comp of components) {
    const types = Array.isArray(comp.types) ? comp.types : [];
    const name = comp.long_name || '';
    if (types.includes('locality')) locality = name;
    if (types.includes('sublocality') || types.includes('sublocality_level_1')) sublocality = sublocality || name;
    if (types.includes('administrative_area_level_2')) admin2 = name;
  }
  const formatted = (first.formatted_address || '').split(',')[0]?.trim() || null;
  return locality || sublocality || admin2 || formatted;
}

async function fetchDirectionsOverviewPolyline(startLat, startLng, endLat, endLng) {
  requireGoogleKey();
  const url =
    `https://maps.googleapis.com/maps/api/directions/json?origin=${startLat},${startLng}&destination=${endLat},${endLng}&key=${GOOGLE_MAPS_API_KEY}`;
  const data = await fetchJsonWithTimeout(url, 10000);
  if (!data || data.status !== 'OK' || !Array.isArray(data.routes) || data.routes.length === 0) {
    return null;
  }
  const route = data.routes[0] || {};
  const poly = route.overview_polyline && route.overview_polyline.points;
  return typeof poly === 'string' && poly.length > 0 ? poly : null;
}

async function enrichRaceDerivedFields(raceDoc) {
  // Place names
  if (!raceDoc.startPoint?.address) {
    const name = await reverseGeocodePlaceName(raceDoc.startPoint.latitude, raceDoc.startPoint.longitude);
    if (name) raceDoc.startPoint.address = name;
  }
  if (!raceDoc.endPoint?.address) {
    const name = await reverseGeocodePlaceName(raceDoc.endPoint.latitude, raceDoc.endPoint.longitude);
    if (name) raceDoc.endPoint.address = name;
  }

  // Route polyline
  if (!raceDoc.routePolyline) {
    const poly = await fetchDirectionsOverviewPolyline(
      raceDoc.startPoint.latitude,
      raceDoc.startPoint.longitude,
      raceDoc.endPoint.latitude,
      raceDoc.endPoint.longitude,
    );
    if (poly) raceDoc.routePolyline = poly;
  }
}

// Get all races
router.get('/', async (req, res) => {
  try {
    console.log('\n📋 [RACES] Fetching all races');
    
    const { status } = req.query;
    const query = status ? { status } : {};
    
    const races = await Race.find(query)
      .populate('participants.user', 'email name nickname avatarUrl')
      .populate('createdBy', 'email name avatarUrl')
      .sort({ startDate: -1 });
    
    // Add distance to each race
    const racesWithDistance = races.map(race => {
      const raceObj = race.toObject();
      raceObj.distance = race.calculateRaceDistance();
      return raceObj;
    });
    
    console.log(`✅ [RACES] Found ${races.length} races`);
    
    res.json({ races: racesWithDistance });
  } catch (error) {
    console.error('❌ [RACES] Error fetching races:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Global leaderboard (protected)
// Aggregates total KM, race participations, and wins (first finisher by completedAt)
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    console.log('\n🏆 [RACES] Fetching GLOBAL leaderboard');

    const races = await Race.find({})
      .populate('participants.user', 'email name nickname avatarUrl');

    const map = new Map(); // userId -> { userId, name, email, totalKm, races, wins }

    for (const race of races) {
      // Determine winner for this race (earliest completion)
      let winnerUserId = null;
      let winnerCompletedAt = null;

      for (const p of race.participants) {
        if (p.status !== 'completed' || !p.completedAt) continue;
        if (!winnerCompletedAt || p.completedAt < winnerCompletedAt) {
          winnerCompletedAt = p.completedAt;
          const uid = (p.user && p.user._id) ? p.user._id : p.user;
          winnerUserId = uid ? uid.toString() : null;
        }
      }

      for (const p of race.participants) {
        const uid = (p.user && p.user._id) ? p.user._id : p.user;
        const userId = uid ? uid.toString() : '';
        if (!userId) continue;

        const name =
          (p.user && p.user.name) ? p.user.name :
          (p.user && p.user.email) ? p.user.email :
          'Participant';

        const email = (p.user && p.user.email) ? p.user.email : '';
        const avatarUrl = (p.user && p.user.avatarUrl) ? p.user.avatarUrl : '';
        const prev = map.get(userId) || {
          userId,
          name,
          email,
          avatarUrl: '',
          totalKm: 0,
          races: 0,
          wins: 0,
        };

        prev.totalKm += Number(p.totalDistance || 0);
        prev.races += 1;
        if (winnerUserId && userId === winnerUserId) {
          prev.wins += 1;
        }

        // keep the first non-empty name/email/avatarUrl
        if ((!prev.name || prev.name === 'Participant') && name) prev.name = name;
        if (!prev.email && email) prev.email = email;
        if (!prev.avatarUrl && avatarUrl) prev.avatarUrl = avatarUrl;

        map.set(userId, prev);
      }
    }

    const leaderboard = Array.from(map.values()).sort((a, b) => {
      if (b.totalKm !== a.totalKm) return b.totalKm - a.totalKm;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return (a.name || '').localeCompare(b.name || '');
    });

    console.log(`✅ [RACES] GLOBAL leaderboard generated: ${leaderboard.length} entries`);

    res.json({ leaderboard });
  } catch (error) {
    console.error('❌ [RACES] Error fetching GLOBAL leaderboard:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Current user stats (protected)
// Returns: races participated, wins, total KM, and win rate.
router.get('/my-stats', authMiddleware, async (req, res) => {
  try {
    console.log(`\n📈 [RACES] Fetching stats for user: ${req.userId}`);

    const races = await Race.find({
      'participants.user': req.userId,
    }).populate('participants.user', 'email name nickname avatarUrl');

    let racesParticipated = 0;
    let wins = 0;
    let totalKm = 0;
    let name = 'Participant';

    for (const race of races) {
      const myParticipant = race.participants.find((p) => {
        const uid = (p.user && p.user._id) ? p.user._id : p.user;
        return uid && uid.toString() === req.userId;
      });

      if (!myParticipant) continue;

      racesParticipated += 1;
      totalKm += Number(myParticipant.totalDistance || 0);

      if ((myParticipant.user && myParticipant.user.name) && name === 'Participant') {
        name = myParticipant.user.name;
      } else if ((myParticipant.user && myParticipant.user.email) && name === 'Participant') {
        name = myParticipant.user.email;
      }

      // Winner is the earliest completed participant in this race.
      let winnerUserId = null;
      let winnerCompletedAt = null;
      for (const p of race.participants) {
        if (p.status !== 'completed' || !p.completedAt) continue;
        if (!winnerCompletedAt || p.completedAt < winnerCompletedAt) {
          winnerCompletedAt = p.completedAt;
          const uid = (p.user && p.user._id) ? p.user._id : p.user;
          winnerUserId = uid ? uid.toString() : null;
        }
      }

      if (winnerUserId && winnerUserId === req.userId) {
        wins += 1;
      }
    }

    const winRate = racesParticipated > 0 ? (wins / racesParticipated) * 100 : 0;

    const stats = {
      userId: req.userId,
      name,
      racesParticipated,
      wins,
      totalKm: Number(totalKm.toFixed(2)),
      winRate: Number(winRate.toFixed(1)),
    };

    console.log('✅ [RACES] User stats ready:', stats);
    res.json({ stats });
  } catch (error) {
    console.error('❌ [RACES] Error fetching user stats:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get race by ID
router.get('/:id', async (req, res) => {
  try {
    console.log(`\n📋 [RACES] Fetching race: ${req.params.id}`);
    
    const race = await Race.findById(req.params.id)
      .populate('participants.user', 'email name nickname avatarUrl')
      .populate('createdBy', 'email name avatarUrl');
    
    if (!race) {
      console.log(`❌ [RACES] Race not found: ${req.params.id}`);
      return res.status(404).json({ message: 'Race not found' });
    }
    
    console.log(`✅ [RACES] Race found: ${race.name}`);
    
    const raceObj = race.toObject();
    raceObj.distance = race.calculateRaceDistance();
    
    res.json({ race: raceObj });
  } catch (error) {
    console.error('❌ [RACES] Error fetching race:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create new race (protected - admin only)
router.post('/', authMiddleware, [
  body('name').notEmpty().trim(),
  body('startPoint.latitude').isFloat(),
  body('startPoint.longitude').isFloat(),
  body('endPoint.latitude').isFloat(),
  body('endPoint.longitude').isFloat(),
  body('startDate').isISO8601(),
  body('endDate').isISO8601(),
], async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('\n🏁 [RACES] Creating new race');
    console.log(`[${new Date().toISOString()}] Created by: ${req.userId}`);
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ [RACES] Validation failed:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, description, startPoint, endPoint, startDate, endDate, image, mimeType } = req.body;

    let imageUrl;
    if (image) {
      if (String(image).startsWith('http')) {
        imageUrl = image;
      } else {
        try {
          imageUrl = await uploadToS3(image, 'race', mimeType || '');
        } catch (err) {
          console.warn('⚠️  [RACES] S3 upload failed:', err?.message);
        }
      }
    }
    
    console.log(`📝 [RACES] Race name: ${name}`);
    console.log(`📍 [RACES] Start: (${startPoint.latitude}, ${startPoint.longitude})`);
    console.log(`📍 [RACES] End: (${endPoint.latitude}, ${endPoint.longitude})`);
    console.log(`📅 [RACES] Start date: ${startDate}`);
    console.log(`📅 [RACES] End date: ${endDate}`);

    const race = new Race({
      name,
      description,
      startPoint,
      endPoint,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      createdBy: req.userId,
      ...(imageUrl && { imageUrl }),
    });

    // Enrich derived fields once (city labels + route polyline) to avoid
    // repeated Google API requests from clients.
    try {
      await enrichRaceDerivedFields(race);
    } catch (e) {
      console.warn('⚠️  [RACES] Enrichment skipped:', e.message || e.toString());
    }

    await race.save();
    
    const raceDistance = race.calculateRaceDistance();
    console.log(`📏 [RACES] Race distance: ${raceDistance.toFixed(2)} km`);
    console.log(`✅ [RACES] Race created successfully!`);
    console.log(`   Race ID: ${race._id}`);
    
    const duration = Date.now() - startTime;
    console.log(`⏱️  Race creation completed in ${duration}ms`);
    console.log('=== RACE CREATION SUCCESS ===\n');

    const populatedRace = await Race.findById(race._id)
      .populate('createdBy', 'email name avatarUrl');

    res.status(201).json({
      message: 'Race created successfully',
      race: populatedRace,
      distance: raceDistance
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('❌ [RACES] Error creating race:', error);
    console.error(`⏱️  Failed after ${duration}ms`);
    console.log('=== RACE CREATION FAILED ===\n');
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Enrich an existing race with derived fields (protected)
router.post('/:id/enrich', authMiddleware, async (req, res) => {
  try {
    console.log(`\n🧠 [RACES] Enriching race ${req.params.id}`);

    const race = await Race.findById(req.params.id);
    if (!race) return res.status(404).json({ message: 'Race not found' });

    await enrichRaceDerivedFields(race);
    await race.save();

    const populated = await Race.findById(race._id)
      .populate('participants.user', 'email name nickname avatarUrl')
      .populate('createdBy', 'email name avatarUrl');

    res.json({ message: 'Race enriched', race: populated });
  } catch (error) {
    console.error('❌ [RACES] Error enriching race:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Join race (protected)
router.post('/:id/join', authMiddleware, async (req, res) => {
  try {
    console.log(`\n👤 [RACES] User ${req.userId} joining race ${req.params.id}`);
    
    const race = await Race.findById(req.params.id);
    
    if (!race) {
      console.log(`❌ [RACES] Race not found: ${req.params.id}`);
      return res.status(404).json({ message: 'Race not found' });
    }

    // Check if race is still open for joining
    const now = new Date();
    if (now > race.endDate) {
      console.log(`❌ [RACES] Race has ended`);
      return res.status(400).json({ message: 'Race has ended' });
    }

    const conflictingRace = await findOngoingParticipation(req.userId, race._id);
    if (conflictingRace) {
      return res.status(400).json({
        message: `You can participate in only one race at a time. Leave or finish "${conflictingRace.name}" first.`,
        conflictingRace: {
          id: conflictingRace._id,
          name: conflictingRace.name,
          startDate: conflictingRace.startDate,
          endDate: conflictingRace.endDate,
        },
      });
    }

    await race.addParticipant(req.userId);
    
    console.log(`✅ [RACES] User joined race successfully`);
    
    const updatedRace = await Race.findById(req.params.id)
      .populate('participants.user', 'email name nickname avatarUrl');

    res.json({
      message: 'Successfully joined race',
      race: updatedRace
    });
  } catch (error) {
    console.error('❌ [RACES] Error joining race:', error);
    if (error.message === 'User is already a participant') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Distance updates are allowed only via Health sync.
router.put('/:id/distance', authMiddleware, async (req, res) => {
  return res.status(403).json({
    message: 'Manual distance updates are disabled. Use /api/races/health/sync.',
  });
});

function asIsoDayString(dateLike) {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function getParticipant(race, userId) {
  return race.participants.find(
    (p) => p.user.toString() === userId.toString(),
  );
}

// HealthKit sync (protected)
// Accepts per-day totals and applies them to the user's most-recent active race participation.
router.post('/health/sync', authMiddleware, [
  body('days').isArray({ min: 1, max: 60 }),
  body('days.*.date').isISO8601(),
  body('days.*.distanceKm').isFloat({ min: 0 }),
], async (req, res) => {
  const startTime = Date.now();

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const now = new Date();
    const days = Array.isArray(req.body.days) ? req.body.days : [];

    // Find active races where user is participant (by date range, not stored status).
    const activeRaces = await Race.find({
      'participants.user': req.userId,
      startDate: { $lte: now },
      endDate: { $gte: now },
    });

    if (!activeRaces.length) {
      return res.json({
        message: 'No active race participation found',
        applied: false,
        deltaKm: 0,
      });
    }

    // Pick race with latest joinedAt.
    let selectedRace = null;
    let latestJoinedAt = null;
    for (const r of activeRaces) {
      const p = getParticipant(r, req.userId);
      if (!p) continue;
      const joinedAt = p.joinedAt ? new Date(p.joinedAt) : null;
      if (!joinedAt || Number.isNaN(joinedAt.getTime())) continue;
      if (!latestJoinedAt || joinedAt > latestJoinedAt) {
        latestJoinedAt = joinedAt;
        selectedRace = r;
      }
    }

    if (!selectedRace) {
      return res.json({
        message: 'No active race participation found',
        applied: false,
        deltaKm: 0,
      });
    }

    const race = selectedRace;
    const participant = getParticipant(race, req.userId);
    if (!participant) {
      return res.json({
        message: 'No active race participation found',
        applied: false,
        deltaKm: 0,
      });
    }

    // Map existing daily entries by ISO day.
    const existingByDay = new Map();
    for (const entry of participant.dailyDistances || []) {
      const key = asIsoDayString(entry.date);
      if (!key) continue;
      existingByDay.set(key, entry);
    }

    let deltaKm = 0;
    for (const item of days) {
      const dayKey = asIsoDayString(item.date);
      if (!dayKey) continue;

      const incoming = Number(item.distanceKm || 0);
      if (!Number.isFinite(incoming) || incoming < 0) continue;

      const existing = existingByDay.get(dayKey);
      const oldDistance = Number(existing?.distance || 0);
      const newDistance = Math.max(oldDistance, incoming); // never move backwards

      if (!existing) {
        participant.dailyDistances.push({
          date: new Date(dayKey),
          distance: newDistance,
        });
      } else {
        existing.distance = newDistance;
      }

      const gained = Math.max(0, newDistance - oldDistance);
      if (gained > 0) {
        deltaKm += gained;
      }
    }

    // Recompute participant totalDistance from entries (safe).
    participant.totalDistance = Number(
      (participant.dailyDistances || []).reduce((sum, d) => sum + Number(d.distance || 0), 0),
    );

    // Completion check.
    const raceDistance = race.calculateRaceDistance();
    if (participant.totalDistance >= raceDistance && participant.status === 'active') {
      participant.status = 'completed';
      participant.completedAt = new Date();
    }

    await race.save();

    let progression = null;
    let lastHealthSyncAt = null;
    if (deltaKm > 0) {
      const user = await User.findById(req.userId);
      if (user) {
        user.totalKmLifetime = Number(
          ((Number(user.totalKmLifetime || 0)) + deltaKm).toFixed(2),
        );
        const xpGain = Math.floor(deltaKm * XP_PER_KM);
        user.totalXp = Number(user.totalXp || 0) + xpGain;
        user.level = levelFromXp(user.totalXp);
        user.lastHealthSyncAt = now;
        lastHealthSyncAt = user.lastHealthSyncAt;
        await user.save();
        progression = progressionFromXp(user.totalXp);
      }
    } else {
      // Still store sync time to avoid repeating expensive reads.
      const user = await User.findById(req.userId).select('lastHealthSyncAt');
      if (user) {
        user.lastHealthSyncAt = now;
        lastHealthSyncAt = user.lastHealthSyncAt;
        await user.save();
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `✅ [RACES] Health sync applied to race ${race._id} for user ${req.userId} (+${deltaKm.toFixed(2)} km) in ${duration}ms`,
    );

    res.json({
      message: 'Health sync applied',
      applied: true,
      raceId: race._id,
      deltaKm: Number(deltaKm.toFixed(3)),
      lastHealthSyncAt,
      progression,
    });
  } catch (error) {
    console.error('❌ [RACES] Error syncing Health data:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get race leaderboard
router.get('/:id/leaderboard', async (req, res) => {
  try {
    console.log(`\n🏆 [RACES] Fetching leaderboard for race ${req.params.id}`);
    
    const race = await Race.findById(req.params.id)
      .populate('participants.user', 'email name nickname avatarUrl');
    
    if (!race) {
      return res.status(404).json({ message: 'Race not found' });
    }

    // Sort participants by total distance (descending)
    const leaderboard = race.participants
      .map(p => ({
        user: p.user,
        totalDistance: p.totalDistance,
        status: p.status,
        completedAt: p.completedAt,
        dailyDistances: p.dailyDistances
      }))
      .sort((a, b) => b.totalDistance - a.totalDistance);
    
    console.log(`✅ [RACES] Leaderboard generated with ${leaderboard.length} participants`);
    
    res.json({
      race: {
        id: race._id,
        name: race.name,
        distance: race.calculateRaceDistance()
      },
      leaderboard
    });
  } catch (error) {
    console.error('❌ [RACES] Error fetching leaderboard:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update race (protected - admin only)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    console.log(`\n✏️  [RACES] Updating race ${req.params.id}`);
    
    const race = await Race.findById(req.params.id);
    
    if (!race) {
      return res.status(404).json({ message: 'Race not found' });
    }

    // Only creator can update
    if (race.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this race' });
    }

    const updates = { ...req.body };
    const { image, mimeType } = updates;
    delete updates.image;
    delete updates.mimeType;

    if (image) {
      if (String(image).startsWith('http')) {
        race.imageUrl = image;
      } else {
        try {
          race.imageUrl = await uploadToS3(image, 'race', mimeType || '');
        } catch (err) {
          console.warn('⚠️  [RACES] S3 upload failed:', err?.message);
        }
      }
    }

    Object.assign(race, updates);
    await race.save();
    
    console.log(`✅ [RACES] Race updated successfully`);
    
    const updatedRace = await Race.findById(req.params.id)
      .populate('participants.user', 'email name nickname avatarUrl')
      .populate('createdBy', 'email name avatarUrl');

    res.json({
      message: 'Race updated successfully',
      race: updatedRace
    });
  } catch (error) {
    console.error('❌ [RACES] Error updating race:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Delete race (protected - admin only)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    console.log(`\n🗑️  [RACES] Deleting race ${req.params.id}`);
    
    const race = await Race.findById(req.params.id);
    
    if (!race) {
      return res.status(404).json({ message: 'Race not found' });
    }

    // Only creator can delete
    if (race.createdBy.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this race' });
    }

    await Race.findByIdAndDelete(req.params.id);
    
    console.log(`✅ [RACES] Race deleted successfully`);
    
    res.json({ message: 'Race deleted successfully' });
  } catch (error) {
    console.error('❌ [RACES] Error deleting race:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
