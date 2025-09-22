const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const Department = require('../models/department');

router.get('/', authMiddleware.auth, async (req, res) => {
  try {
    const departments = await Department.find().sort({ createdAt: -1 });
    console.log('Departments fetched:', departments);
    res.status(200).json(departments);
  } catch (err) {
    console.error('Get departments error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', authMiddleware.auth, async (req, res) => {
  try {
    const department = new Department({
      name: req.body.name,
      code: req.body.code,
      description: req.body.description,
      createdBy: req.user._id,
    });
    await department.save();
    res.status(201).json(department);
  } catch (err) {
    console.error('Create department error:', err);
    res.status(400).json({ message: 'Error creating department', error: err.message });
  }
});

router.put('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }
    department.name = req.body.name || department.name;
    department.code = req.body.code || department.code;
    department.description = req.body.description || department.description;
    await department.save();
    res.status(200).json(department);
  } catch (err) {
    console.error('Update department error:', err);
    res.status(400).json({ message: 'Error updating department', error: err.message });
  }
});

router.delete('/:id', authMiddleware.auth, async (req, res) => {
  try {
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }
    await department.deleteOne();
    res.status(200).json({ message: 'Department deleted' });
  } catch (err) {
    console.error('Delete department error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;