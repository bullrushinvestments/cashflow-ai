import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireMinRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config/env';

const router = Router();

router.use(authenticate);

// GET /api/v1/forecasts - Get latest forecasts
router.get('/', async (req, res, next) => {
  try {
    const schema = z.object({
      scenario: z.enum(['pessimistic', 'baseline', 'optimistic']).default('baseline'),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
    });

    const query = schema.parse(req.query);

    // Get latest forecast run
    const latestRun = await prisma.forecastRun.findFirst({
      where: {
        companyId: req.user!.companyId,
        status: 'completed',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestRun) {
      return res.json({ forecasts: [], latestRun: null });
    }

    const where: any = {
      companyId: req.user!.companyId,
      forecastRunId: latestRun.id,
      scenario: query.scenario,
    };

    if (query.startDate) where.forecastDate = { gte: new Date(query.startDate) };
    if (query.endDate) where.forecastDate = { ...where.forecastDate, lte: new Date(query.endDate) };

    const forecasts = await prisma.forecast.findMany({
      where,
      select: {
        id: true,
        forecastDate: true,
        predictedBalance: true,
        predictedInflow: true,
        predictedOutflow: true,
        confidenceLower: true,
        confidenceUpper: true,
        confidenceLevel: true,
        scenario: true,
      },
      orderBy: { forecastDate: 'asc' },
    });

    res.json({
      forecasts: forecasts.map(f => ({
        ...f,
        predictedBalance: Number(f.predictedBalance) / 100,
        predictedInflow: Number(f.predictedInflow) / 100,
        predictedOutflow: Number(f.predictedOutflow) / 100,
        confidenceLower: Number(f.confidenceLower) / 100,
        confidenceUpper: Number(f.confidenceUpper) / 100,
        confidenceLevel: Number(f.confidenceLevel),
      })),
      latestRun: {
        id: latestRun.id,
        createdAt: latestRun.createdAt,
        modelVersion: latestRun.modelVersion,
        accuracyMetrics: latestRun.accuracyMetrics,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/forecasts/generate - Trigger new forecast
router.post('/generate', requireMinRole('controller'), async (req, res, next) => {
  try {
    const schema = z.object({
      horizonDays: z.number().int().min(7).max(365).default(90),
    });

    const { horizonDays } = schema.parse(req.body);

    // Check for minimum data
    const transactionCount = await prisma.transaction.count({
      where: { companyId: req.user!.companyId },
    });

    if (transactionCount < 90) {
      throw new AppError('Minimum 90 days of transaction data required for forecasting', 400);
    }

    // Create forecast run
    const forecastRun = await prisma.forecastRun.create({
      data: {
        companyId: req.user!.companyId,
        triggeredBy: req.user!.id,
        triggerType: 'manual',
        status: 'pending',
        modelVersion: '1.0.0',
        dataRangeStart: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), // 1 year back
        dataRangeEnd: new Date(),
        forecastHorizonDays: horizonDays,
      },
    });

    // Trigger ML service asynchronously
    try {
      await fetch(`${config.mlServiceUrl}/forecast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          forecastRunId: forecastRun.id,
          companyId: req.user!.companyId,
          horizonDays,
        }),
      });
    } catch (mlError) {
      console.error('Failed to trigger ML service:', mlError);
      // Continue - ML service will pick up from queue
    }

    res.status(202).json({
      message: 'Forecast generation initiated',
      forecastRunId: forecastRun.id,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/forecasts/runs - List forecast runs
router.get('/runs', async (req, res, next) => {
  try {
    const runs = await prisma.forecastRun.findMany({
      where: { companyId: req.user!.companyId },
      select: {
        id: true,
        triggerType: true,
        status: true,
        modelVersion: true,
        accuracyMetrics: true,
        forecastHorizonDays: true,
        processingTimeMs: true,
        createdAt: true,
        completedAt: true,
        triggerer: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    res.json(runs);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/forecasts/runs/:id - Get specific forecast run
router.get('/runs/:id', async (req, res, next) => {
  try {
    const run = await prisma.forecastRun.findFirst({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
      include: {
        triggerer: {
          select: { firstName: true, lastName: true },
        },
      },
    });

    if (!run) {
      throw new AppError('Forecast run not found', 404);
    }

    res.json(run);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/forecasts/compare - Compare scenarios
router.get('/compare', async (req, res, next) => {
  try {
    const latestRun = await prisma.forecastRun.findFirst({
      where: {
        companyId: req.user!.companyId,
        status: 'completed',
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestRun) {
      return res.json({ scenarios: {} });
    }

    const forecasts = await prisma.forecast.findMany({
      where: {
        forecastRunId: latestRun.id,
      },
      select: {
        forecastDate: true,
        predictedBalance: true,
        scenario: true,
      },
      orderBy: { forecastDate: 'asc' },
    });

    // Group by date and scenario
    const grouped: Record<string, Record<string, number>> = {};
    for (const f of forecasts) {
      const date = f.forecastDate.toISOString().split('T')[0];
      if (!grouped[date]) grouped[date] = {};
      grouped[date][f.scenario] = Number(f.predictedBalance) / 100;
    }

    res.json({
      scenarios: grouped,
      forecastRunId: latestRun.id,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/forecasts/accuracy - Get historical accuracy
router.get('/accuracy', async (req, res, next) => {
  try {
    const runs = await prisma.forecastRun.findMany({
      where: {
        companyId: req.user!.companyId,
        status: 'completed',
        accuracyMetrics: { not: null },
      },
      select: {
        id: true,
        createdAt: true,
        accuracyMetrics: true,
        modelVersion: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    res.json(runs);
  } catch (error) {
    next(error);
  }
});

export default router;
