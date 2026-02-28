#!/usr/bin/env node

/**
 * Creates test users, logs them in, and joins them to a race.
 *
 * Example:
 *   node scripts/seed_race_participants.js \
 *     --base-url https://serveracegm.bcmenu.ro/api \
 *     --race-id 67bea9b9f4d6c6b0ac65f123 \
 *     --count 50 \
 *     --prefix loadtest \
 *     --password Test1234!
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) {
      out._.push(current);
      continue;
    }
    if (current.includes('=')) {
      const [rawKey, ...rest] = current.slice(2).split('=');
      out[rawKey] = rest.join('=');
      continue;
    }
    const key = current.slice(2);
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

function nowTag() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return (
    String(d.getFullYear()).slice(-2) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function sanitizeToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '');
}

function buildNickname(prefix, tag, index) {
  const safePrefix = sanitizeToken(prefix || 'loadtest') || 'loadtest';
  const suffix = `${tag}${index}`;
  const maxPrefixLen = Math.max(3, 24 - suffix.length);
  const trimmedPrefix = safePrefix.slice(0, maxPrefixLen);
  let nickname = `${trimmedPrefix}${suffix}`;
  nickname = sanitizeToken(nickname);
  if (nickname.length < 3) {
    nickname = `u${String(index).padStart(2, '0')}${tag}`.slice(0, 24);
  }
  return nickname.slice(0, 24);
}

function buildEmail(prefix, tag, index) {
  const safePrefix = sanitizeToken(prefix || 'loadtest') || 'loadtest';
  return `${safePrefix}.${tag}.${index}@example.com`;
}

async function postJson(url, body, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }

  return { status: response.status, data };
}

function extractMessage(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string') return payload.message;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    if (first && typeof first.msg === 'string') return first.msg;
  }
  return '';
}

async function registerOrLogin(baseUrl, user) {
  const registerUrl = `${baseUrl}/auth/register`;
  const loginUrl = `${baseUrl}/auth/login`;

  const registerBody = {
    email: user.email,
    password: user.password,
    nickname: user.nickname,
    name: user.name,
  };

  const registerRes = await postJson(registerUrl, registerBody);
  if (registerRes.status === 201 && registerRes.data.token) {
    return { token: registerRes.data.token, mode: 'registered' };
  }

  const registerMsg = extractMessage(registerRes.data).toLowerCase();
  const shouldLogin =
    registerRes.status === 400 &&
    (registerMsg.includes('already exists') ||
      registerMsg.includes('already in use') ||
      registerMsg.includes('exists'));

  if (!shouldLogin) {
    throw new Error(
      `register failed (${registerRes.status}): ${
        extractMessage(registerRes.data) || 'unknown error'
      }`,
    );
  }

  const loginRes = await postJson(loginUrl, {
    email: user.email,
    password: user.password,
  });
  if (loginRes.status === 200 && loginRes.data.token) {
    return { token: loginRes.data.token, mode: 'logged_in' };
  }

  throw new Error(
    `login failed (${loginRes.status}): ${
      extractMessage(loginRes.data) || 'unknown error'
    }`,
  );
}

async function joinRace(baseUrl, raceId, token) {
  const joinUrl = `${baseUrl}/races/${raceId}/join`;
  const res = await postJson(joinUrl, {}, token);

  if (res.status === 200 || res.status === 201) {
    return { state: 'joined', message: extractMessage(res.data) };
  }

  const message = extractMessage(res.data);
  if (
    res.status === 400 &&
    typeof message === 'string' &&
    message.toLowerCase().includes('already a participant')
  ) {
    return { state: 'already_joined', message };
  }

  return {
    state: 'failed',
    message: message || `join failed with status ${res.status}`,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (nextIndex < items.length) {
      const i = nextIndex;
      nextIndex += 1;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = [];
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  for (let i = 0; i < safeConcurrency; i += 1) {
    runners.push(runner());
  }
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const positional = Array.isArray(args._) ? args._ : [];
  const raceId = String(args['race-id'] || positional[0] || '').trim();
  const count = Number(args.count || positional[1] || 50);
  const baseUrl = String(
    args['base-url'] || positional[2] || 'http://localhost:3000/api',
  ).replace(/\/+$/, '');
  const prefix = String(args.prefix || 'loadtest');
  const password = String(args.password || 'Test1234!');
  const concurrency = Number(args.concurrency || 5);
  const outputFile = args.out ? String(args.out) : '';
  const tag = sanitizeToken(String(args.tag || nowTag()));

  if (!raceId) {
    throw new Error('Missing required --race-id');
  }
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error('--count must be a positive number');
  }

  const users = Array.from({ length: count }, (_, idx) => {
    const i = idx + 1;
    return {
      index: i,
      email: buildEmail(prefix, tag, i),
      nickname: buildNickname(prefix, tag, i),
      password,
      name: `Load User ${i}`,
    };
  });

  console.log(
    `Seeding participants: baseUrl=${baseUrl}, raceId=${raceId}, count=${count}, concurrency=${concurrency}`,
  );

  const results = await mapWithConcurrency(users, concurrency, async (user) => {
    try {
      const auth = await registerOrLogin(baseUrl, user);
      const join = await joinRace(baseUrl, raceId, auth.token);
      const item = {
        ...user,
        authMode: auth.mode,
        joinState: join.state,
        joinMessage: join.message || '',
        ok: join.state === 'joined' || join.state === 'already_joined',
      };
      console.log(
        `[${user.index}/${count}] ${user.email} -> ${item.authMode}, ${item.joinState}`,
      );
      return item;
    } catch (error) {
      const item = {
        ...user,
        authMode: 'failed',
        joinState: 'failed',
        joinMessage: error?.message || String(error),
        ok: false,
      };
      console.log(
        `[${user.index}/${count}] ${user.email} -> failed (${item.joinMessage})`,
      );
      return item;
    }
  });

  const summary = {
    total: results.length,
    registered: results.filter((r) => r.authMode === 'registered').length,
    loggedInExisting: results.filter((r) => r.authMode === 'logged_in').length,
    joined: results.filter((r) => r.joinState === 'joined').length,
    alreadyJoined: results.filter((r) => r.joinState === 'already_joined').length,
    failed: results.filter((r) => !r.ok).length,
  };

  console.log('\nSummary');
  console.log(JSON.stringify(summary, null, 2));

  if (outputFile) {
    const outPath = path.resolve(process.cwd(), outputFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      JSON.stringify({ createdAt: new Date().toISOString(), summary, results }, null, 2),
      'utf8',
    );
    console.log(`Saved results to ${outPath}`);
  }
}

main().catch((error) => {
  console.error(`Fatal: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
