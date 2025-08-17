// server/routes/notifications.js
const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification'); // MongoDB model
const jwt = require('jsonwebtoken');

// Middleware to verify JWT
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// Create a notification
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { user, type, message, data } = req.body;
    if (!user || !type || !message) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const notification = new Notification({
      user,
      type,
      message,
      data,
      read: false,
      createdAt: new Date(),
    });
    await notification.save();
    res.status(201).json(notification);
  } catch (err) {
    console.error('Error creating notification:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all notifications for a user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { user, read, page = 1, limit = 10 } = req.query;
    const query = { user };
    if (read !== undefined) query.read = read === 'true';
    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    res.json(notifications);
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get a single notification by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) return res.status(404).json({ message: 'Notification not found' });
    res.json(notification);
  } catch (err) {
    console.error('Error fetching notification:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Mark a notification as read
router.patch('/:id/read', authMiddleware, async (req, res) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      { read: true },
      { new: true }
    );
    if (!notification) return res.status(404).json({ message: 'Notification not found' });
    res.json(notification);
  } catch (err) {
    console.error('Error marking notification as read:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete a notification
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const notification = await Notification.findByIdAndDelete(req.params.id);
    if (!notification) return res.status(404).json({ message: 'Notification not found' });
    res.json({ message: 'Notification deleted' });
  } catch (err) {
    console.error('Error deleting notification:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Mark all notifications as read for a user
router.patch('/mark-all-read', authMiddleware, async (req, res) => {
  try {
    const { user } = req.body;
    await Notification.updateMany({ user, read: false }, { read: true });
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('Error marking all notifications as read:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;