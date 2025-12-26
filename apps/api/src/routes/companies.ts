import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

router.use(authenticate);

// GET /api/v1/companies/current
router.get('/current', async (req, res, next) => {
  try {
    const company = await prisma.company.findUnique({
      where: { id: req.user!.companyId },
      select: {
        id: true,
        name: true,
        industry: true,
        employeeCount: true,
        annualRevenue: true,
        timezone: true,
        currency: true,
        subscriptionTier: true,
        subscriptionStatus: true,
        stripeCustomerId: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            users: true,
            bankAccounts: true,
          },
        },
      },
    });

    res.json({
      ...company,
      annualRevenue: company ? Number(company.annualRevenue) / 100 : 0, // Convert cents to dollars
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/companies/current - Update company (admin/cfo only)
router.put('/current', requireRole('admin', 'cfo'), async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(255).optional(),
      industry: z.enum(['manufacturing', 'professional_services', 'saas', 'retail', 'other']).optional(),
      employeeCount: z.number().int().min(1).optional(),
      annualRevenue: z.number().min(0).optional(),
      timezone: z.string().max(50).optional(),
      currency: z.string().length(3).optional(),
    });

    const data = schema.parse(req.body);

    const updateData: any = { ...data };
    if (data.annualRevenue !== undefined) {
      updateData.annualRevenue = BigInt(Math.round(data.annualRevenue * 100));
      delete updateData.annualRevenue;
    }

    const company = await prisma.company.update({
      where: { id: req.user!.companyId },
      data: updateData,
      select: {
        id: true,
        name: true,
        industry: true,
        employeeCount: true,
        annualRevenue: true,
        timezone: true,
        currency: true,
        updatedAt: true,
      },
    });

    res.json({
      ...company,
      annualRevenue: Number(company.annualRevenue) / 100,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
