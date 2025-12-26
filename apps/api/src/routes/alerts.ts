import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireMinRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();

router.use(authenticate);

// GET /api/v1/alerts
router.get('/', async (req, res, next) => {
  try {
    const schema = z.object({
      status: z.enum(['active', 'acknowledged', 'resolved', 'dismissed']).optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional(),
      type: z.enum(['cash_shortage', 'late_payment_risk', 'anomaly', 'working_capital', 'forecast_deviation']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    });

    const query = schema.parse(req.query);

    const where: any = {
      companyId: req.user!.companyId,
    };

    if (query.status) where.status = query.status;
    if (query.severity) where.severity = query.severity;
    if (query.type) where.alertType = query.type;

    const [alerts, total] = await Promise.all([
      prisma.alert.findMany({
        where,
        select: {
          id: true,
          alertType: true,
          severity: true,
          title: true,
          message: true,
          metadata: true,
          predictedDate: true,
          predictedAmount: true,
          status: true,
          acknowledgedAt: true,
          createdAt: true,
          expiresAt: true,
          acknowledger: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: [
          { severity: 'desc' },
          { createdAt: 'desc' },
        ],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.alert.count({ where }),
    ]);

    res.json({
      data: alerts.map(a => ({
        ...a,
        predictedAmount: a.predictedAmount ? Number(a.predictedAmount) / 100 : null,
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

// GET /api/v1/alerts/summary - Get alert counts by status
router.get('/summary', async (req, res, next) => {
  try {
    const [byStatus, bySeverity] = await Promise.all([
      prisma.alert.groupBy({
        by: ['status'],
        where: { companyId: req.user!.companyId },
        _count: true,
      }),
      prisma.alert.groupBy({
        by: ['severity'],
        where: {
          companyId: req.user!.companyId,
          status: 'active',
        },
        _count: true,
      }),
    ]);

    res.json({
      byStatus: Object.fromEntries(byStatus.map(s => [s.status, s._count])),
      bySeverity: Object.fromEntries(bySeverity.map(s => [s.severity, s._count])),
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/alerts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const alert = await prisma.alert.findFirst({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
      include: {
        acknowledger: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
    });

    if (!alert) {
      throw new AppError('Alert not found', 404);
    }

    res.json({
      ...alert,
      predictedAmount: alert.predictedAmount ? Number(alert.predictedAmount) / 100 : null,
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/alerts/:id/acknowledge
router.put('/:id/acknowledge', requireMinRole('analyst'), async (req, res, next) => {
  try {
    const alert = await prisma.alert.update({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
      data: {
        status: 'acknowledged',
        acknowledgedBy: req.user!.id,
        acknowledgedAt: new Date(),
      },
      select: {
        id: true,
        status: true,
        acknowledgedAt: true,
      },
    });

    res.json(alert);
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/alerts/:id/resolve
router.put('/:id/resolve', requireMinRole('analyst'), async (req, res, next) => {
  try {
    const alert = await prisma.alert.update({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
      data: {
        status: 'resolved',
      },
      select: {
        id: true,
        status: true,
      },
    });

    res.json(alert);
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/alerts/:id/dismiss
router.put('/:id/dismiss', requireMinRole('analyst'), async (req, res, next) => {
  try {
    const alert = await prisma.alert.update({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
      data: {
        status: 'dismissed',
      },
      select: {
        id: true,
        status: true,
      },
    });

    res.json(alert);
  } catch (error) {
    next(error);
  }
});

export default router;
