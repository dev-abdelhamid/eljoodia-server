const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventory');
const inventoryStockController = require('../controllers/inventoryStock');
const { authMiddleware } = require('../middleware/auth');

// Inventory Stock Routes
router.get('/', authMiddleware(['admin', 'branch']), inventoryStockController.getInventory);
router.get('/branch/:branchId', authMiddleware(['admin', 'branch']), inventoryStockController.getInventoryByBranch);
router.post('/', authMiddleware(['admin', 'branch']), inventoryStockController.createInventory);
router.put('/:id', authMiddleware(['admin', 'branch']), inventoryStockController.updateStock);
router.put('/:id/limits', authMiddleware(['admin', 'branch']), inventoryStockController.updateStockLimits);
router.post('/bulk', authMiddleware(['admin', 'branch']), inventoryStockController.bulkCreate);

// Inventory Return and History Routes
router.post('/returns', authMiddleware(['admin', 'branch']), inventoryController.createReturn);
router.get('/returns', authMiddleware(['admin', 'branch']), inventoryController.getReturns);
router.patch('/returns/:returnId/process', authMiddleware(['admin', 'branch']), inventoryController.approveReturn);
router.get('/history', authMiddleware(['admin', 'branch']), inventoryController.getInventoryHistory);
router.get('/product/:productId/branch/:branchId', authMiddleware(['admin', 'branch']), inventoryController.getProductDetails);

module.exports = router;