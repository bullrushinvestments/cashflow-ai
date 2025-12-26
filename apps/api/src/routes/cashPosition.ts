import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();

router.use(authenticate);

// GET /api/v1/cash-position/current
router.get('/current', async (req, res, next) => {
  try {
    const accounts = await prisma.bankAccount.findMany({
      where: {
        companyId: req.user!.companyId,
        isActive: true,
      },
      select: {
        id: true,
        accountName: true,
        institutionName: true,
        accountType: true,
        currentBalance: true,
        availableBalance: true,
        currency: true,
        lastSyncedAt: true,
      },
    });

    const totalBalance = accounts.reduce(
      (sum, acc) => sum + Number(acc.currentBalance),
      0
    );

    const totalAvailable = accounts.reduce(
      (sum, acc) => sum + Number(acc.availableBalance),
      0
    );

    res.json({
      totalBalance: totalBalance / 100,
      totalAvailable: totalAvailable / 100,
      currency: 'USD',
      accounts: accounts.map(a => ({
        ...a,
        currentBalance: Number(a.currentBalance) / 100,
        availableBalance: Number(a.availableBalance) / 100,
      })),
      lastUpdated: accounts.reduce((latest, acc) => {
        if (!acc.lastSyncedAt) return latest;
        if (!latest) return acc.lastSyncedAt;
        return acc.lastSyncedAt > latest ? acc.lastSyncedAt : latest;
      }, null as Date | null),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/cash-position/history
router.get('/history', async (req, res, next) => {
  try {
    const schema = z.object({
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
      granularity: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
    });

    const query = schema.parse(req.query);

    const startDate = query.startDate
      ? new Date(query.startDate)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days default

    const endDate = query.endDate ? new Date(query.endDate) : new Date();

    // Get daily transaction sums
    const transactions = await prisma.transaction.findMany({
      where: {
        companyId: req.user!.companyId,
        transactionDate: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        transactionDate: true,
        amount: true,
      },
      orderBy: { transactionDate: 'asc' },
    });

    // Group by date
    const dailyChanges: Record<string, number> = {};
    for (const tx of transactions) {
      const date = tx.transactionDate.toISOString().split('T')[0];
      dailyChanges[date] = (dailyChanges[date] || 0) + Number(tx.amount);
    }

    // Calculate running balance (working backward from current)
    const accounts = await prisma.bankAccount.findMany({
      where: { companyId: req.user!.companyId, isActive: true },
      select: { currentBalance: true },
    });

    let currentBalance = accounts.reduce(
      (sum, acc) => sum + Number(acc.currentBalance),
      0
    );

    // Build history array
    const dates = Object.keys(dailyChanges).sort();
    const history: { date: string; balance: number; change: number }[] = [];

    // Calculate historical balances by subtracting future changes
    let runningBalance = currentBalance;
    for (let i = dates.length - 1; i >= 0; i--) {
      const date = dates[i];
      const change = dailyChanges[date];
      history.unshift({
        date,
        balance: runningBalance / 100,
        change: change / 100,
      });
      runningBalance -= change;
    }

    // Aggregate if needed
    if (query.granularity === 'weekly' || query.granularity === 'monthly') {
      const aggregated: typeof history = [];
      let period = '';
      let periodBalance = 0;
      let periodChange = 0;

      for (const item of history) {
        const itemPeriod = query.granularity === 'weekly'
          ? getWeekStart(item.date)
          : item.date.substring(0, 7); // YYYY-MM

        if (period !== itemPeriod && period !== '') {
          aggregated.push({
            date: period,
            balance: periodBalance,
            change: periodChange,
          });
          periodChange = 0;
        }

        period = itemPeriod;
        periodBalance = item.balance;
        periodChange += item.change;
      }

      if (period) {
        aggregated.push({ date: period, balance: periodBalance, change: periodChange });
      }

      return res.json({ history: aggregated, granularity: query.granularity });
    }

    res.json({ history, granularity: 'daily' });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/cash-position/by-account
router.get('/by-account', async (req, res, next) => {
  try {
    const accounts = await prisma.bankAccount.findMany({
      where: {
        companyId: req.user!.companyId,
        isActive: true,
      },
      select: {
        id: true,
        accountName: true,
        institutionName: true,
        accountType: true,
        currentBalance: true,
        currency: true,
        _count: {
          select: { transactions: true },
        },
      },
    });

    const totalBalance = accounts.reduce(
      (sum, acc) => sum + Number(acc.currentBalance),
      0
    );

    res.json({
      accounts: accounts.map(a => ({
        id: a.id,
        name: a.accountName,
        institution: a.institutionName,
        type: a.accountType,
        balance: Number(a.currentBalance) / 100,
        percentage: totalBalance > 0
          ? (Number(a.currentBalance) / totalBalance) * 100
          : 0,
        transactionCount: a._count.transactions,
      })),
      totalBalance: totalBalance / 100,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/cash-position/inflows-outflows
router.get('/inflows-outflows', async (req, res, next) => {
  try {
    const schema = z.object({
      period: z.enum(['7d', '30d', '90d', '365d']).default('30d'),
    });

    const { period } = schema.parse(req.query);

    const days = parseInt(period);
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [inflows, outflows] = await Promise.all([
      prisma.transaction.aggregate({
        where: {
          companyId: req.user!.companyId,
          transactionDate: { gte: startDate },
          amount: { gt: 0 },
        },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.transaction.aggregate({
        where: {
          companyId: req.user!.companyId,
          transactionDate: { gte: startDate },
          amount: { lt: 0 },
        },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    const inflowAmount = Number(inflows._sum.amount || 0) / 100;
    const outflowAmount = Math.abs(Number(outflows._sum.amount || 0)) / 100;
    const netFlow = inflowAmount - outflowAmount;

    res.json({
      period,
      inflows: {
        total: inflowAmount,
        count: inflows._count,
        avgPerDay: inflowAmount / days,
      },
      outflows: {
        total: outflowAmount,
        count: outflows._count,
        avgPerDay: outflowAmount / days,
      },
      netFlow,
      burnRate: outflowAmount / days,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/cash-position/runway
router.get('/runway', async (req, res, next) => {
  try {
    // Get current balance
    const accounts = await prisma.bankAccount.findMany({
      where: { companyId: req.user!.companyId, isActive: true },
      select: { currentBalance: true },
    });

    const currentBalance = accounts.reduce(
      (sum, acc) => sum + Number(acc.currentBalance),
      0
    ) / 100;

    // Calculate average monthly burn over last 3 months
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const outflows = await prisma.transaction.aggregate({
      where: {
        companyId: req.user!.companyId,
        transactionDate: { gte: threeMonthsAgo },
        amount: { lt: 0 },
      },
      _sum: { amount: true },
    });

    const totalOutflow = Math.abs(Number(outflows._sum.amount || 0)) / 100;
    const avgMonthlyBurn = totalOutflow / 3;

    const runwayMonths = avgMonthlyBurn > 0
      ? currentBalance / avgMonthlyBurn
      : Infinity;

    res.json({
      currentBalance,
      avgMonthlyBurn,
      runwayMonths: Math.round(runwayMonths * 10) / 10,
      runwayDays: Math.round(runwayMonths * 30),
      projectedZeroDate: runwayMonths !== Infinity
        ? new Date(Date.now() + runwayMonths * 30 * 24 * 60 * 60 * 1000)
        : null,
    });
  } catch (error) {
    next(error);
  }
});

function getWeekStart(dateStr: string): string {
  const date = new Date(dateStr);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  return date.toISOString().split('T')[0];
}

export default router;
