import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import { config } from '../config/env';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { AppError } from '../middleware/errorHandler';
import { UserRole } from '@prisma/client';
import { encrypt, decrypt, isEncrypted } from '../lib/encryption';

const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_PREFIX = 'refresh:';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  companyName: string;
  industry: string;
  employeeCount: number;
  annualRevenue: number;
}

interface LoginInput {
  email: string;
  password: string;
  mfaCode?: string;
}

export class AuthService {
  async register(input: RegisterInput): Promise<TokenPair> {
    const existingUser = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });

    if (existingUser) {
      throw new AppError('Email already registered', 409);
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    // Create company and user in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: input.companyName,
          industry: input.industry as any,
          employeeCount: input.employeeCount,
          annualRevenue: BigInt(input.annualRevenue * 100), // Convert to cents
        },
      });

      const user = await tx.user.create({
        data: {
          email: input.email.toLowerCase(),
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          role: 'admin', // First user is admin
          companyId: company.id,
        },
      });

      return { user, company };
    });

    return this.generateTokens(result.user);
  }

  async login(input: LoginInput): Promise<TokenPair & { requiresMfa?: boolean }> {
    const user = await prisma.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });

    if (!user) {
      throw new AppError('Invalid credentials', 401);
    }

    const isValidPassword = await bcrypt.compare(input.password, user.passwordHash);
    if (!isValidPassword) {
      throw new AppError('Invalid credentials', 401);
    }

    // Check if MFA is enabled
    if (user.mfaEnabled && user.mfaSecret) {
      if (!input.mfaCode) {
        return { accessToken: '', refreshToken: '', requiresMfa: true };
      }

      // Decrypt MFA secret if encrypted
      const mfaSecret = isEncrypted(user.mfaSecret)
        ? decrypt(user.mfaSecret)
        : user.mfaSecret;

      const isValidMfa = authenticator.verify({
        token: input.mfaCode,
        secret: mfaSecret,
      });

      if (!isValidMfa) {
        throw new AppError('Invalid MFA code', 401);
      }
    }

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.generateTokens(user);
  }

  async refreshToken(refreshToken: string): Promise<TokenPair> {
    try {
      const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret) as {
        userId: string;
        tokenId: string;
      };

      // Check if token is revoked
      const isRevoked = await redis.get(`${REFRESH_TOKEN_PREFIX}${decoded.tokenId}`);
      if (isRevoked === 'revoked') {
        throw new AppError('Token revoked', 401);
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
      });

      if (!user) {
        throw new AppError('User not found', 401);
      }

      // Revoke old refresh token
      await this.revokeRefreshToken(decoded.tokenId);

      return this.generateTokens(user);
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        throw new AppError('Invalid refresh token', 401);
      }
      throw error;
    }
  }

  async logout(userId: string, refreshToken: string): Promise<void> {
    try {
      const decoded = jwt.verify(refreshToken, config.jwt.refreshSecret) as {
        tokenId: string;
      };
      await this.revokeRefreshToken(decoded.tokenId);
    } catch {
      // Ignore invalid tokens during logout
    }
  }

  async setupMfa(userId: string): Promise<{ secret: string; qrCode: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, 'CashFlow AI', secret);

    // Store secret temporarily (not enabled yet)
    await redis.setex(`mfa_setup:${userId}`, 600, secret); // 10 minute expiry

    return { secret, qrCode: otpauth };
  }

  async verifyAndEnableMfa(userId: string, code: string): Promise<void> {
    const secret = await redis.get(`mfa_setup:${userId}`);
    if (!secret) {
      throw new AppError('MFA setup expired, please start again', 400);
    }

    const isValid = authenticator.verify({ token: code, secret });
    if (!isValid) {
      throw new AppError('Invalid MFA code', 400);
    }

    // Encrypt MFA secret before storing
    const encryptedSecret = encrypt(secret);

    await prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaSecret: encryptedSecret },
    });

    await redis.del(`mfa_setup:${userId}`);
  }

  async disableMfa(userId: string, password: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      throw new AppError('Invalid password', 401);
    }

    await prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecret: null },
    });
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const isValidPassword = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isValidPassword) {
      throw new AppError('Invalid current password', 401);
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });
  }

  private async generateTokens(user: {
    id: string;
    email: string;
    role: UserRole;
    companyId: string;
  }): Promise<TokenPair> {
    const tokenId = crypto.randomUUID();

    const accessToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        companyId: user.companyId,
      },
      config.jwt.secret,
      { expiresIn: config.jwt.accessExpiresIn }
    );

    const refreshToken = jwt.sign(
      { userId: user.id, tokenId },
      config.jwt.refreshSecret,
      { expiresIn: config.jwt.refreshExpiresIn }
    );

    return { accessToken, refreshToken };
  }

  private async revokeRefreshToken(tokenId: string): Promise<void> {
    // Store revoked token for 7 days (refresh token lifetime)
    await redis.setex(`${REFRESH_TOKEN_PREFIX}${tokenId}`, 7 * 24 * 60 * 60, 'revoked');
  }
}

export const authService = new AuthService();
