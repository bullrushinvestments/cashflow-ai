import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireMinRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();

router.use(authenticate);

// GET /api/v1/bank-accounts
router.get('/', async (req, res, next) => {
  try {
    const accounts = await prisma.bankAccount.findMany({
      where: {
        companyId: req.user!.companyId,
        isActive: true,
      },
      select: {
        id: true,
        institutionName: true,
        accountName: true,
        accountType: true,
        mask: true,
        currentBalance: true,
        availableBalance: true,
        currency: true,
        lastSyncedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(accounts.map(a => ({
      ...a,
      currentBalance: Number(a.currentBalance) / 100,
      availableBalance: Number(a.availableBalance) / 100,
    })));
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/bank-accounts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const account = await prisma.bankAccount.findFirst({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
      select: {
        id: true,
        institutionName: true,
        institutionId: true,
        accountName: true,
        accountType: true,
        accountSubtype: true,
        mask: true,
        currentBalance: true,
        availableBalance: true,
        currency: true,
        isActive: true,
        lastSyncedAt: true,
        createdAt: true,
      },
    });

    if (!account) {
      throw new AppError('Bank account not found', 404);
    }

    res.json({
      ...account,
      currentBalance: Number(account.currentBalance) / 100,
      availableBalance: Number(account.availableBalance) / 100,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/bank-accounts/:id - Disconnect account (admin/cfo only)
router.delete('/:id', requireMinRole('cfo'), async (req, res, next) => {
  try {
    const account = await prisma.bankAccount.findFirst({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
    });

    if (!account) {
      throw new AppError('Bank account not found', 404);
    }

    // Soft delete - mark as inactive
    await prisma.bankAccount.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/bank-accounts/:id/sync - Trigger manual sync
router.post('/:id/sync', requireMinRole('controller'), async (req, res, next) => {
  try {
    const account = await prisma.bankAccount.findFirst({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
        isActive: true,
      },
    });

    if (!account) {
      throw new AppError('Bank account not found', 404);
    }

    // TODO: Trigger Plaid sync via integration service
    // For now, just update lastSyncedAt
    await prisma.bankAccount.update({
      where: { id: req.params.id },
      data: { lastSyncedAt: new Date() },
    });

    res.json({ message: 'Sync initiated', accountId: req.params.id });
  } catch (error) {
    next(error);
  }
});

export default router;
