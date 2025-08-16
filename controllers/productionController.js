const ProductionAssignment = require('../models/ProductionAssignment');
const Order = require('../models/Order');
const Chef = require('../models/Chef');

exports.getProductionAssignments = async (req, res) => {
  try {
    const assignments = await ProductionAssignment.find()
      .populate('order', 'orderNumber status')
      .populate('product', 'name category')
      .populate('chef', 'username department');
    res.json(assignments);
  } catch (error) {
    console.error('Get production assignments error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.assignProduction = async (req, res) => {
  try {
    const { orderId, items } = req.body;
    // Validate order exists
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    // Validate chefs and departments
    const assignments = await Promise.all(
      items.map(async (item) => {
        const chef = await Chef.findById(item.assignedTo).populate('user', 'username');
        if (!chef) {
          throw new Error(`Chef not found: ${item.assignedTo}`);
        }
        const product = await Product.findById(item.productId);
        if (!product) {
          throw new Error(`Product not found: ${item.productId}`);
        }
        const departmentMap = {
          'حلويات شرقية': 'eastern-sweets',
          'حلويات غربية': 'western-sweets',
          'كيك وتورت': 'cake',
          'معجنات': 'pastries',
          'مخبوزات': 'bakery',
        };
        if (chef.department !== departmentMap[product.category]) {
          throw new Error(`Chef ${chef.user.username} department (${chef.department}) does not match product category (${product.category})`);
        }
        const assignment = new ProductionAssignment({
          order: orderId,
          product: item.productId,
          chef: item.assignedTo,
          quantity: item.quantity,
          status: 'in_progress',
          startedAt: new Date(),
        });
        return assignment.save();
      })
    );
    // Update order items
    await Order.findByIdAndUpdate(orderId, {
      $set: {
        'items.$[elem].assignedChef': items.map(item => item.assignedTo),
        'items.$[elem].status': 'in_progress',
      },
    }, {
      arrayFilters: [{ 'elem.product': { $in: items.map(item => item.productId) } }],
    });
    res.status(201).json(assignments);
  } catch (error) {
    console.error('Assign production error:', error);
    res.status(400).json({ success: false, message: error.message });
  }
};

exports.confirmProductionCompletion = async (req, res) => {
  try {
    const assignment = await ProductionAssignment.findById(req.params.id);
    if (!assignment) {
      return res.status(404).json({ success: false, message: 'Assignment not found' });
    }
    assignment.status = 'completed';
    assignment.completedAt = new Date();
    await assignment.save();
    // Check if all assignments for the order are completed
    const assignments = await ProductionAssignment.find({ order: assignment.order });
    const allCompleted = assignments.every(a => a.status === 'completed');
    if (allCompleted) {
      await Order.findByIdAndUpdate(assignment.order, {
        status: 'completed',
        deliveredAt: new Date(),
      });
    }
    res.json(assignment);
  } catch (error) {
    console.error('Confirm production completion error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};