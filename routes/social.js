const express = require('express');
const { body, query, validationResult } = require('express-validator');
const authMiddleware = require('../middleware/auth');
const User = require('../models/User');
const Race = require('../models/Race');
const FriendRequest = require('../models/FriendRequest');
const RaceInvite = require('../models/RaceInvite');

const router = express.Router();

function ensureValid(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return false;
  }
  return true;
}

function normalizeNickname(nickname) {
  return String(nickname || '').trim().toLowerCase();
}

async function areFriends(userIdA, userIdB) {
  const accepted = await FriendRequest.findOne({ status: 'accepted' }).or([
    { fromUser: userIdA, toUser: userIdB },
    { fromUser: userIdB, toUser: userIdA },
  ]);
  return Boolean(accepted);
}

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user._id?.toString?.() || user.id?.toString?.() || '',
    name: user.name || '',
    email: user.email || '',
    nickname: user.nickname || '',
  };
}

// Search users by nickname prefix
router.get('/users/search', authMiddleware, [
  query('nickname').trim().isLength({ min: 2, max: 24 }),
], async (req, res) => {
  try {
    if (!ensureValid(req, res)) return;

    const term = normalizeNickname(req.query.nickname);
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const users = await User.find({
      _id: { $ne: req.userId },
      nickname: { $regex: `^${escaped}`, $options: 'i' },
    })
      .select('name email nickname')
      .limit(10)
      .sort({ nickname: 1 });

    res.json({ users: users.map(toPublicUser) });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Send friend request by nickname
router.post('/friends/request', authMiddleware, [
  body('nickname').trim().isLength({ min: 3, max: 24 }).matches(/^[a-z0-9._]+$/),
], async (req, res) => {
  try {
    if (!ensureValid(req, res)) return;

    const nickname = normalizeNickname(req.body.nickname);
    const fromUserId = req.userId;
    const toUser = await User.findOne({ nickname });

    if (!toUser) {
      return res.status(404).json({ message: 'User not found for this nickname' });
    }
    if (toUser._id.toString() === fromUserId.toString()) {
      return res.status(400).json({ message: 'You cannot add yourself' });
    }

    if (await areFriends(fromUserId, toUser._id)) {
      return res.status(400).json({ message: 'You are already friends' });
    }

    const existingPending = await FriendRequest.findOne({
      fromUser: fromUserId,
      toUser: toUser._id,
      status: 'pending',
    });
    if (existingPending) {
      return res.status(400).json({ message: 'Friend request already sent' });
    }

    const reversePending = await FriendRequest.findOne({
      fromUser: toUser._id,
      toUser: fromUserId,
      status: 'pending',
    });
    if (reversePending) {
      reversePending.status = 'accepted';
      reversePending.respondedAt = new Date();
      await reversePending.save();
      return res.json({ message: 'Friend request accepted automatically', autoAccepted: true });
    }

    const created = await FriendRequest.create({
      fromUser: fromUserId,
      toUser: toUser._id,
      status: 'pending',
    });

    const populated = await FriendRequest.findById(created._id)
      .populate('fromUser', 'name email nickname')
      .populate('toUser', 'name email nickname');

    res.status(201).json({ message: 'Friend request sent', request: populated });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get accepted friends
router.get('/friends', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const accepted = await FriendRequest.find({ status: 'accepted' })
      .or([{ fromUser: userId }, { toUser: userId }])
      .populate('fromUser', 'name email nickname')
      .populate('toUser', 'name email nickname')
      .sort({ respondedAt: -1, createdAt: -1 });

    const friends = accepted
      .map((item) => {
        const other = item.fromUser._id.toString() === userId.toString() ? item.toUser : item.fromUser;
        return toPublicUser(other);
      })
      .filter((u) => u && u.id);

    res.json({ friends });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get friend requests (incoming/outgoing pending)
router.get('/friends/requests', authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const incoming = await FriendRequest.find({ toUser: userId, status: 'pending' })
      .populate('fromUser', 'name email nickname')
      .sort({ createdAt: -1 });

    const outgoing = await FriendRequest.find({ fromUser: userId, status: 'pending' })
      .populate('toUser', 'name email nickname')
      .sort({ createdAt: -1 });

    const mapRequest = (reqDoc, direction) => ({
      id: reqDoc._id.toString(),
      status: reqDoc.status,
      createdAt: reqDoc.createdAt,
      direction,
      user: direction === 'incoming' ? toPublicUser(reqDoc.fromUser) : toPublicUser(reqDoc.toUser),
    });

    res.json({
      incoming: incoming.map((r) => mapRequest(r, 'incoming')),
      outgoing: outgoing.map((r) => mapRequest(r, 'outgoing')),
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Accept/reject friend request
router.post('/friends/requests/:id/respond', authMiddleware, [
  body('action').isIn(['accept', 'reject']),
], async (req, res) => {
  try {
    if (!ensureValid(req, res)) return;

    const request = await FriendRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Friend request not found' });

    if (request.toUser.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'Not authorized to respond to this request' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Friend request already handled' });
    }

    request.status = req.body.action === 'accept' ? 'accepted' : 'rejected';
    request.respondedAt = new Date();
    await request.save();

    res.json({ message: `Friend request ${request.status}` });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Invite a friend to race
router.post('/races/:raceId/invites', authMiddleware, [
  body('friendId').notEmpty(),
], async (req, res) => {
  try {
    if (!ensureValid(req, res)) return;

    const race = await Race.findById(req.params.raceId);
    if (!race) return res.status(404).json({ message: 'Race not found' });

    const inviterId = req.userId;
    const friendId = req.body.friendId;

    const inviterIsParticipant = race.participants.some(
      (p) => p.user.toString() === inviterId.toString(),
    );
    const inviterIsCreator = race.createdBy.toString() === inviterId.toString();
    if (!inviterIsParticipant && !inviterIsCreator) {
      return res.status(403).json({ message: 'Join race before sending invites' });
    }

    if (friendId.toString() === inviterId.toString()) {
      return res.status(400).json({ message: 'Cannot invite yourself' });
    }

    const isFriend = await areFriends(inviterId, friendId);
    if (!isFriend) {
      return res.status(400).json({ message: 'You can invite only accepted friends' });
    }

    const alreadyParticipant = race.participants.some(
      (p) => p.user.toString() === friendId.toString(),
    );
    if (alreadyParticipant) {
      return res.status(400).json({ message: 'User is already a participant' });
    }

    if (new Date() > race.endDate) {
      return res.status(400).json({ message: 'Race has ended' });
    }

    const existingPending = await RaceInvite.findOne({
      race: race._id,
      fromUser: inviterId,
      toUser: friendId,
      status: 'pending',
    });
    if (existingPending) {
      return res.status(400).json({ message: 'Invite already sent' });
    }

    const invite = await RaceInvite.create({
      race: race._id,
      fromUser: inviterId,
      toUser: friendId,
      status: 'pending',
    });

    const populated = await RaceInvite.findById(invite._id)
      .populate('race', 'name startDate endDate')
      .populate('fromUser', 'name email nickname')
      .populate('toUser', 'name email nickname');

    res.status(201).json({ message: 'Race invite sent', invite: populated });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get incoming pending race invites
router.get('/race-invites', authMiddleware, async (req, res) => {
  try {
    const invites = await RaceInvite.find({ toUser: req.userId, status: 'pending' })
      .populate('race', 'name startDate endDate')
      .populate('fromUser', 'name email nickname')
      .sort({ createdAt: -1 });

    const mapped = invites.map((invite) => ({
      id: invite._id.toString(),
      status: invite.status,
      createdAt: invite.createdAt,
      race: {
        id: invite.race?._id?.toString?.() || '',
        name: invite.race?.name || '',
        startDate: invite.race?.startDate,
        endDate: invite.race?.endDate,
      },
      fromUser: toPublicUser(invite.fromUser),
    }));

    res.json({ invites: mapped });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Accept/reject race invite
router.post('/race-invites/:id/respond', authMiddleware, [
  body('action').isIn(['accept', 'reject']),
], async (req, res) => {
  try {
    if (!ensureValid(req, res)) return;

    const invite = await RaceInvite.findById(req.params.id);
    if (!invite) return res.status(404).json({ message: 'Invite not found' });

    if (invite.toUser.toString() !== req.userId.toString()) {
      return res.status(403).json({ message: 'Not authorized for this invite' });
    }
    if (invite.status !== 'pending') {
      return res.status(400).json({ message: 'Invite already handled' });
    }

    if (req.body.action === 'reject') {
      invite.status = 'rejected';
      invite.respondedAt = new Date();
      await invite.save();
      return res.json({ message: 'Invite rejected' });
    }

    const race = await Race.findById(invite.race);
    if (!race) {
      invite.status = 'expired';
      invite.respondedAt = new Date();
      await invite.save();
      return res.status(400).json({ message: 'Race no longer exists' });
    }

    if (new Date() > race.endDate) {
      invite.status = 'expired';
      invite.respondedAt = new Date();
      await invite.save();
      return res.status(400).json({ message: 'Race has ended' });
    }

    const alreadyParticipant = race.participants.some(
      (p) => p.user.toString() === req.userId.toString(),
    );
    if (!alreadyParticipant) {
      await race.addParticipant(req.userId);
    }

    invite.status = 'accepted';
    invite.respondedAt = new Date();
    await invite.save();

    res.json({ message: 'Invite accepted. You joined the race.' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;
