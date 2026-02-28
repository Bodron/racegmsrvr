#!/usr/bin/env node

/**
 * Direct DB seeder for race participant distances.
 *
 * Examples:
 *   node scripts/set_race_distances_db.js --race-id 67c123... --min-km 0.5 --max-km 8
 *   node scripts/set_race_distances_db.js --race-id 67c123... --nickname-prefix loadtest --dry-run
 */

const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const Race = require('../models/Race');
require('../models/User');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    if (arg.includes('=')) {
      const [rawKey, ...rest] = arg.slice(2).split('=');
      out[rawKey] = rest.join('=');
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

function toIsoDay(date) {
  return new Date(date).toISOString().split('T')[0];
}

async function main() {
  const args = parseArgs(process.argv);
  const positional = Array.isArray(args._) ? args._ : [];
  const raceId = String(args['race-id'] || positional[0] || '').trim();
  const minKm = Number(args['min-km'] || positional[2] || 0.2);
  const maxKmArg = args['max-km'] != null ? Number(args['max-km']) : null;
  const nicknamePrefix = String(
    args['nickname-prefix'] || positional[1] || '',
  )
    .trim()
    .toLowerCase();
  const dryRun = Boolean(args['dry-run']);

  if (!raceId) {
    throw new Error('Missing required --race-id');
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('Missing MONGODB_URI in server/.env');
  }
  if (!Number.isFinite(minKm) || minKm < 0) {
    throw new Error('--min-km must be >= 0');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const race = await Race.findById(raceId).populate(
    'participants.user',
    'nickname email name',
  );
  if (!race) {
    throw new Error(`Race not found: ${raceId}`);
  }

  const raceDistance = Number(race.calculateRaceDistance() || 0);
  const defaultMax = raceDistance > 0 ? Math.max(minKm, raceDistance * 0.9) : Math.max(minKm, 8);
  const maxKm = maxKmArg == null ? defaultMax : maxKmArg;
  if (!Number.isFinite(maxKm) || maxKm < minKm) {
    throw new Error('--max-km must be >= --min-km');
  }

  const todayKey = toIsoDay(new Date());
  let touched = 0;
  let skipped = 0;

  for (const participant of race.participants) {
    const user = participant.user && typeof participant.user === 'object'
      ? participant.user
      : null;
    const nickname = String(user?.nickname || '').toLowerCase();
    if (nicknamePrefix && !nickname.startsWith(nicknamePrefix)) {
      skipped += 1;
      continue;
    }

    const distance = Number(randBetween(minKm, maxKm).toFixed(3));
    participant.dailyDistances = [
      {
        date: new Date(todayKey),
        distance,
      },
    ];
    participant.totalDistance = distance;

    if (raceDistance > 0 && distance >= raceDistance) {
      participant.status = 'completed';
      participant.completedAt = new Date();
    } else {
      participant.status = 'active';
      participant.completedAt = undefined;
    }

    touched += 1;
  }

  if (!dryRun) {
    await race.save();
  }

  console.log(
    JSON.stringify(
      {
        raceId,
        raceName: race.name,
        raceDistanceKm: Number(raceDistance.toFixed(3)),
        minKm,
        maxKm,
        nicknamePrefix: nicknamePrefix || null,
        touchedParticipants: touched,
        skippedParticipants: skipped,
        dryRun,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(`Fatal: ${error?.message || String(error)}`);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exitCode = 1;
});
