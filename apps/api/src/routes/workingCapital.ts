import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();

router.use(authenticate);

// GET /api/v1/working-capital/metrics
router.get('/metrics', async (req, res, next) => {
  try {
    // Get latest metrics
    const latestMetric = await prisma.workingCapitalMetric.findFirst({
      where: { companyId: req.user!.companyId },
      orderBy: { metricDate: 'desc' },
    });

    if (!latestMetric) {
      return res.json({
        dso: null,
        dpo: null,
        ccc: null,
        arBalance: null,
        apBalance: null,
        cashBalance: null,
        lastCalculated: null,
      });
    }

    res.json({
      dso: latestMetric.dso ? Number(latestMetric.dso) : null,
      dpo: latestMetric.dpo ? Number(latestMetric.dpo) : null,
      ccc: latestMetric.ccc ? Number(latestMetric.ccc) : null,
      arBalance: latestMetric.arBalance ? Number(latestMetric.arBalance) / 100 : null,
      apBalance: latestMetric.apBalance ? Number(latestMetric.apBalance) / 100 : null,
      cashBalance: latestMetric.cashBalance ? Number(latestMetric.cashBalance) / 100 : null,
      lastCalculated: latestMetric.metricDate,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/working-capital/history
router.get('/history', async (req, res, next) => {
  try {
    const schema = z.object({
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
    });

    const query = schema.parse(req.query);

    const where: any = { companyId: req.user!.companyId };

    if (query.startDate) {
      where.metricDate = { gte: new Date(query.startDate) };
    }
    if (query.endDate) {
      where.metricDate = { ...where.metricDate, lte: new Date(query.endDate) };
    }

    const metrics = await prisma.workingCapitalMetric.findMany({
      where,
      select: {
        metricDate: true,
        dso: true,
        dpo: true,
        ccc: true,
        arBalance: true,
        apBalance: true,
        cashBalance: true,
      },
      orderBy: { metricDate: 'asc' },
    });

    res.json(metrics.map(m => ({
      date: m.metricDate,
      dso: m.dso ? Number(m.dso) : null,
      dpo: m.dpo ? Number(m.dpo) : null,
      ccc: m.ccc ? Number(m.ccc) : null,
      arBalance: m.arBalance ? Number(m.arBalance) / 100 : null,
      apBalance: m.apBalance ? Number(m.apBalance) / 100 : null,
      cashBalance: m.cashBalance ? Number(m.cashBalance) / 100 : null,
    })));
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/working-capital/dso
router.get('/dso', async (req, res, next) => {
  try {
    // Calculate DSO from invoices
    const invoices = await prisma.invoice.findMany({
      where: {
        companyId: req.user!.companyId,
        type: 'receivable',
        status: 'paid',
        paidDate: { not: null },
      },
      select: {
        issueDate: true,
        paidDate: true,
        amount: true,
      },
      orderBy: { paidDate: 'desc' },
      take: 100,
    });

    if (invoices.length === 0) {
      return res.json({ dso: null, sampleSize: 0 });
    }

    // Calculate weighted average days to collect
    let totalWeightedDays = 0;
    let totalAmount = 0;

    for (const inv of invoices) {
      if (!inv.paidDate) continue;
      const days = Math.ceil(
        (inv.paidDate.getTime() - inv.issueDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      totalWeightedDays += days * Number(inv.amount);
      totalAmount += Number(inv.amount);
    }

    const dso = totalAmount > 0 ? totalWeightedDays / totalAmount : 0;

    // Get trend (compare to 30 days ago)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const previousMetric = await prisma.workingCapitalMetric.findFirst({
      where: {
        companyId: req.user!.companyId,
        metricDate: { lte: thirtyDaysAgo },
      },
      orderBy: { metricDate: 'desc' },
      select: { dso: true },
    });

    res.json({
      dso: Math.round(dso * 10) / 10,
      previousDso: previousMetric?.dso ? Number(previousMetric.dso) : null,
      trend: previousMetric?.dso
        ? dso > Number(previousMetric.dso)
          ? 'increasing'
          : dso < Number(previousMetric.dso)
            ? 'decreasing'
            : 'stable'
        : null,
      sampleSize: invoices.length,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/working-capital/dpo
router.get('/dpo', async (req, res, next) => {
  try {
    // Calculate DPO from payable invoices
    const invoices = await prisma.invoice.findMany({
      where: {
        companyId: req.user!.companyId,
        type: 'payable',
        status: 'paid',
        paidDate: { not: null },
      },
      select: {
        issueDate: true,
        paidDate: true,
        amount: true,
      },
      orderBy: { paidDate: 'desc' },
      take: 100,
    });

    if (invoices.length === 0) {
      return res.json({ dpo: null, sampleSize: 0 });
    }

    let totalWeightedDays = 0;
    let totalAmount = 0;

    for (const inv of invoices) {
      if (!inv.paidDate) continue;
      const days = Math.ceil(
        (inv.paidDate.getTime() - inv.issueDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      totalWeightedDays += days * Number(inv.amount);
      totalAmount += Number(inv.amount);
    }

    const dpo = totalAmount > 0 ? totalWeightedDays / totalAmount : 0;

    res.json({
      dpo: Math.round(dpo * 10) / 10,
      sampleSize: invoices.length,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/working-capital/recommendations
router.get('/recommendations', async (req, res, next) => {
  try {
    const latestMetric = await prisma.workingCapitalMetric.findFirst({
      where: { companyId: req.user!.companyId },
      orderBy: { metricDate: 'desc' },
    });

    const recommendations: {
      type: string;
      priority: 'high' | 'medium' | 'low';
      message: string;
      potentialImpact: string;
    }[] = [];

    if (latestMetric) {
      const dso = latestMetric.dso ? Number(latestMetric.dso) : null;
      const dpo = latestMetric.dpo ? Number(latestMetric.dpo) : null;
      const ccc = latestMetric.ccc ? Number(latestMetric.ccc) : null;

      // DSO recommendations
      if (dso && dso > 45) {
        recommendations.push({
          type: 'collections',
          priority: dso > 60 ? 'high' : 'medium',
          message: `Your DSO of ${dso.toFixed(1)} days is above the 45-day target. Consider tightening payment terms or improving collection processes.`,
          potentialImpact: `Reducing DSO by 10 days could improve cash flow by ~$${Math.round(Number(latestMetric.arBalance || 0) * 10 / dso / 100).toLocaleString()}`,
        });
      }

      // DPO recommendations
      if (dpo && dpo < 30) {
        recommendations.push({
          type: 'payables',
          priority: 'medium',
          message: `Your DPO of ${dpo.toFixed(1)} days suggests you may be paying suppliers too quickly. Consider negotiating longer payment terms.`,
          potentialImpact: 'Extending DPO to 45 days would keep more cash in operations.',
        });
      }

      // CCC recommendations
      if (ccc && ccc > 60) {
        recommendations.push({
          type: 'cash_cycle',
          priority: 'high',
          message: `Your cash conversion cycle of ${ccc.toFixed(1)} days indicates cash is tied up for too long. Focus on reducing inventory and receivables.`,
          potentialImpact: 'A 20% reduction in CCC could significantly improve liquidity.',
        });
      }
    }

    // Check for overdue invoices
    const overdueCount = await prisma.invoice.count({
      where: {
        companyId: req.user!.companyId,
        type: 'receivable',
        status: 'overdue',
      },
    });

    if (overdueCount > 0) {
      recommendations.push({
        type: 'collections',
        priority: 'high',
        message: `You have ${overdueCount} overdue receivable invoices requiring immediate attention.`,
        potentialImpact: 'Collecting overdue invoices will directly improve cash position.',
      });
    }

    res.json({
      recommendations,
      lastUpdated: latestMetric?.metricDate || null,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
