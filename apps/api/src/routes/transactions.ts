import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireMinRole } from '../middleware/auth';

const router = Router();

router.use(authenticate);

// GET /api/v1/transactions
router.get('/', async (req, res, next) => {
  try {
    const schema = z.object({
      bankAccountId: z.string().uuid().optional(),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
      category: z.string().optional(),
      type: z.enum(['inflow', 'outflow', 'transfer']).optional(),
      isRecurring: z.enum(['true', 'false']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    });

    const query = schema.parse(req.query);

    const where: any = {
      companyId: req.user!.companyId,
    };

    if (query.bankAccountId) where.bankAccountId = query.bankAccountId;
    if (query.startDate) where.transactionDate = { gte: new Date(query.startDate) };
    if (query.endDate) where.transactionDate = { ...where.transactionDate, lte: new Date(query.endDate) };
    if (query.category) where.categoryPrimary = query.category;
    if (query.type) where.transactionType = query.type;
    if (query.isRecurring) where.isRecurring = query.isRecurring === 'true';

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        select: {
          id: true,
          transactionDate: true,
          amount: true,
          categoryPrimary: true,
          categoryDetailed: true,
          merchantName: true,
          description: true,
          pending: true,
          transactionType: true,
          isRecurring: true,
          recurringPattern: true,
          bankAccount: {
            select: {
              id: true,
              accountName: true,
              institutionName: true,
            },
          },
        },
        orderBy: { transactionDate: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.transaction.count({ where }),
    ]);

    res.json({
      data: transactions.map(t => ({
        ...t,
        amount: Number(t.amount) / 100,
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/transactions/categories - Get category breakdown
router.get('/categories', async (req, res, next) => {
  try {
    const schema = z.object({
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
    });

    const query = schema.parse(req.query);

    const where: any = {
      companyId: req.user!.companyId,
    };

    if (query.startDate) where.transactionDate = { gte: new Date(query.startDate) };
    if (query.endDate) where.transactionDate = { ...where.transactionDate, lte: new Date(query.endDate) };

    const categories = await prisma.transaction.groupBy({
      by: ['categoryPrimary', 'transactionType'],
      where,
      _sum: { amount: true },
      _count: true,
    });

    res.json(categories.map(c => ({
      category: c.categoryPrimary || 'Uncategorized',
      type: c.transactionType,
      totalAmount: Number(c._sum.amount || 0) / 100,
      count: c._count,
    })));
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/transactions/:id/categorize - Update category
router.put('/:id/categorize', requireMinRole('analyst'), async (req, res, next) => {
  try {
    const schema = z.object({
      categoryPrimary: z.string().max(100),
      categoryDetailed: z.string().max(100).optional(),
    });

    const data = schema.parse(req.body);

    const transaction = await prisma.transaction.update({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
      data,
      select: {
        id: true,
        categoryPrimary: true,
        categoryDetailed: true,
      },
    });

    res.json(transaction);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/transactions/recurring - Get recurring transactions
router.get('/recurring', async (req, res, next) => {
  try {
    const transactions = await prisma.transaction.findMany({
      where: {
        companyId: req.user!.companyId,
        isRecurring: true,
      },
      select: {
        id: true,
        merchantName: true,
        amount: true,
        recurringPattern: true,
        transactionType: true,
        categoryPrimary: true,
        bankAccount: {
          select: {
            accountName: true,
          },
        },
      },
      distinct: ['merchantName', 'amount', 'recurringPattern'],
      orderBy: { amount: 'desc' },
    });

    res.json(transactions.map(t => ({
      ...t,
      amount: Number(t.amount) / 100,
    })));
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/transactions/:id/recurring - Mark as recurring
router.put('/:id/recurring', requireMinRole('analyst'), async (req, res, next) => {
  try {
    const schema = z.object({
      isRecurring: z.boolean(),
      recurringPattern: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'annual']).optional(),
    });

    const data = schema.parse(req.body);

    const transaction = await prisma.transaction.update({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
      data: {
        isRecurring: data.isRecurring,
        recurringPattern: data.isRecurring ? data.recurringPattern : null,
      },
      select: {
        id: true,
        isRecurring: true,
        recurringPattern: true,
      },
    });

    res.json(transaction);
  } catch (error) {
    next(error);
  }
});

export default router;
