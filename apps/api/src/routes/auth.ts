import { Router } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service';
import { authenticate } from '../middleware/auth';

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/,
    'Password must contain uppercase, lowercase, number, and special character'
  ),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  companyName: z.string().min(1).max(255),
  industry: z.enum(['manufacturing', 'professional_services', 'saas', 'retail', 'other']),
  employeeCount: z.number().int().min(1),
  annualRevenue: z.number().min(0),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  mfaCode: z.string().length(6).optional(),
});

// POST /api/v1/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    const tokens = await authService.register(data);
    res.status(201).json(tokens);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const data = loginSchema.parse(req.body);
    const result = await authService.login(data);

    if (result.requiresMfa) {
      return res.status(200).json({ requiresMfa: true });
    }

    res.json({ accessToken: result.accessToken, refreshToken: result.refreshToken });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    const tokens = await authService.refreshToken(refreshToken);
    res.json(tokens);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/logout
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
    await authService.logout(req.user!.id, refreshToken);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/mfa/setup
router.post('/mfa/setup', authenticate, async (req, res, next) => {
  try {
    const result = await authService.setupMfa(req.user!.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/mfa/verify
router.post('/mfa/verify', authenticate, async (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().length(6) }).parse(req.body);
    await authService.verifyAndEnableMfa(req.user!.id, code);
    res.json({ message: 'MFA enabled successfully' });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/mfa/disable
router.post('/mfa/disable', authenticate, async (req, res, next) => {
  try {
    const { password } = z.object({ password: z.string() }).parse(req.body);
    await authService.disableMfa(req.user!.id, password);
    res.json({ message: 'MFA disabled successfully' });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/auth/change-password
router.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const schema = z.object({
      oldPassword: z.string(),
      newPassword: z.string().min(12),
    });
    const { oldPassword, newPassword } = schema.parse(req.body);
    await authService.changePassword(req.user!.id, oldPassword, newPassword);
    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;
