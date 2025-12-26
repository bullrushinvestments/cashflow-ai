import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireRole, requireMinRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

const router = Router();

// All routes require authentication
router.use(authenticate);

// GET /api/v1/users/me
router.get('/me', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        mfaEnabled: true,
        lastLoginAt: true,
        createdAt: true,
        company: {
          select: {
            id: true,
            name: true,
            industry: true,
            subscriptionTier: true,
            subscriptionStatus: true,
          },
        },
      },
    });

    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.json(user);
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/users/me
router.put('/me', async (req, res, next) => {
  try {
    const schema = z.object({
      firstName: z.string().min(1).max(100).optional(),
      lastName: z.string().min(1).max(100).optional(),
    });

    const data = schema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });

    res.json(user);
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/users - List team members (admin/cfo only)
router.get('/', requireMinRole('controller'), async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: { companyId: req.user!.companyId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        mfaEnabled: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(users);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/users - Invite new user (admin only)
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      email: z.string().email(),
      firstName: z.string().min(1).max(100),
      lastName: z.string().min(1).max(100),
      role: z.enum(['cfo', 'controller', 'analyst', 'viewer']),
    });

    const data = schema.parse(req.body);

    // Check if email exists
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) {
      throw new AppError('Email already registered', 409);
    }

    // Create user with temporary password (should be reset)
    const tempPassword = crypto.randomUUID();
    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const user = await prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        passwordHash,
        firstName: data.firstName,
        lastName: data.lastName,
        role: data.role,
        companyId: req.user!.companyId,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });

    // TODO: Send invite email with password reset link

    res.status(201).json(user);
  } catch (error) {
    next(error);
  }
});

// PUT /api/v1/users/:id - Update user role (admin only)
router.put('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const schema = z.object({
      role: z.enum(['cfo', 'controller', 'analyst', 'viewer']),
    });

    const { role } = schema.parse(req.body);

    // Can't change own role
    if (req.params.id === req.user!.id) {
      throw new AppError('Cannot change your own role', 400);
    }

    const user = await prisma.user.update({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
      data: { role },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
      },
    });

    res.json(user);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/users/:id - Remove user (admin only)
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    // Can't delete self
    if (req.params.id === req.user!.id) {
      throw new AppError('Cannot delete your own account', 400);
    }

    await prisma.user.delete({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
