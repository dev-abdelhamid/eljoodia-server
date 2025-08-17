const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { createTask, getTasks, getChefTasks, updateTaskStatus } = require('../controllers/ProductionAssignment');

router.post('/', authMiddleware.auth, authMiddleware.authorize('admin', 'production'), createTask);
router.get('/', authMiddleware.auth, getTasks);
router.get('/chef/:chefId', authMiddleware.auth, getChefTasks);
router.patch('/:id/status', authMiddleware.auth, authMiddleware.authorize('chef'), updateTaskStatus);

module.exports = router;