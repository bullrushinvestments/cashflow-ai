import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, requireMinRole } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config/env';
import { encrypt, decrypt, isEncrypted } from '../lib/encryption';

const router = Router();

router.use(authenticate);

// Plaid client initialization (when keys are available)
let plaidClient: any = null;
async function getPlaidClient() {
  if (plaidClient) return plaidClient;
  if (!config.plaid.clientId || !config.plaid.secret) {
    throw new AppError('Plaid not configured', 503);
  }

  const { Configuration, PlaidApi, PlaidEnvironments } = await import('plaid');
  const configuration = new Configuration({
    basePath: PlaidEnvironments[config.plaid.env],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': config.plaid.clientId,
        'PLAID-SECRET': config.plaid.secret,
      },
    },
  });
  plaidClient = new PlaidApi(configuration);
  return plaidClient;
}

// GET /api/v1/integrations
router.get('/', async (req, res, next) => {
  try {
    const integrations = await prisma.integration.findMany({
      where: { companyId: req.user!.companyId },
      select: {
        id: true,
        provider: true,
        status: true,
        lastSyncedAt: true,
        syncFrequencyMinutes: true,
        errorMessage: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(integrations);
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/integrations/plaid/link-token - Create Plaid Link token
router.post('/plaid/link-token', requireMinRole('cfo'), async (req, res, next) => {
  try {
    const client = await getPlaidClient();

    const response = await client.linkTokenCreate({
      user: { client_user_id: req.user!.companyId },
      client_name: 'CashFlow AI',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
      webhook: `${process.env.API_BASE_URL || 'http://localhost:3001'}/api/v1/webhooks/plaid`,
    });

    res.json({ linkToken: response.data.link_token });
  } catch (error) {
    console.error('Plaid link token error:', error);
    next(new AppError('Failed to create Plaid link token', 500));
  }
});

// POST /api/v1/integrations/plaid/exchange - Exchange public token
router.post('/plaid/exchange', requireMinRole('cfo'), async (req, res, next) => {
  try {
    const schema = z.object({
      publicToken: z.string(),
      metadata: z.object({
        institution: z.object({
          name: z.string(),
          institution_id: z.string(),
        }),
        accounts: z.array(z.object({
          id: z.string(),
          name: z.string(),
          type: z.string(),
          subtype: z.string().optional(),
          mask: z.string().optional(),
        })),
      }),
    });

    const { publicToken, metadata } = schema.parse(req.body);
    const client = await getPlaidClient();

    // Exchange public token for access token
    const exchangeResponse = await client.itemPublicTokenExchange({
      public_token: publicToken,
    });

    const accessToken = exchangeResponse.data.access_token;
    const encryptedAccessToken = encrypt(accessToken);

    // Create or update integration
    await prisma.integration.upsert({
      where: {
        companyId_provider: {
          companyId: req.user!.companyId,
          provider: 'plaid',
        },
      },
      create: {
        companyId: req.user!.companyId,
        provider: 'plaid',
        status: 'connected',
        credentials: { accessToken: encryptedAccessToken },
        lastSyncedAt: new Date(),
      },
      update: {
        status: 'connected',
        credentials: { accessToken: encryptedAccessToken },
        lastSyncedAt: new Date(),
        errorMessage: null,
      },
    });

    // Create bank accounts
    for (const account of metadata.accounts) {
      await prisma.bankAccount.upsert({
        where: { plaidAccountId: account.id },
        create: {
          companyId: req.user!.companyId,
          plaidAccountId: account.id,
          plaidAccessToken: encryptedAccessToken,
          institutionName: metadata.institution.name,
          institutionId: metadata.institution.institution_id,
          accountName: account.name,
          accountType: mapAccountType(account.type),
          accountSubtype: account.subtype,
          mask: account.mask,
        },
        update: {
          institutionName: metadata.institution.name,
          accountName: account.name,
          isActive: true,
        },
      });
    }

    // Trigger initial sync
    await syncTransactions(req.user!.companyId, accessToken);

    res.json({ message: 'Bank accounts connected successfully' });
  } catch (error) {
    console.error('Plaid exchange error:', error);
    next(new AppError('Failed to connect bank account', 500));
  }
});

// POST /api/v1/integrations/:id/sync - Trigger manual sync
router.post('/:id/sync', requireMinRole('controller'), async (req, res, next) => {
  try {
    const integration = await prisma.integration.findFirst({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
    });

    if (!integration) {
      throw new AppError('Integration not found', 404);
    }

    if (integration.provider === 'plaid') {
      const credentials = integration.credentials as { accessToken: string };
      const decryptedToken = decrypt(credentials.accessToken);
      await syncTransactions(req.user!.companyId, decryptedToken);
    }

    await prisma.integration.update({
      where: { id: req.params.id },
      data: { lastSyncedAt: new Date() },
    });

    res.json({ message: 'Sync initiated' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/integrations/:id - Disconnect integration
router.delete('/:id', requireMinRole('admin'), async (req, res, next) => {
  try {
    const integration = await prisma.integration.findFirst({
      where: {
        id: req.params.id,
        companyId: req.user!.companyId,
      },
    });

    if (!integration) {
      throw new AppError('Integration not found', 404);
    }

    // Mark related bank accounts as inactive
    await prisma.bankAccount.updateMany({
      where: { companyId: req.user!.companyId },
      data: { isActive: false },
    });

    await prisma.integration.update({
      where: { id: req.params.id },
      data: { status: 'disconnected' },
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Helper functions
function mapAccountType(plaidType: string): 'checking' | 'savings' | 'credit' | 'investment' | 'other' {
  const mapping: Record<string, 'checking' | 'savings' | 'credit' | 'investment' | 'other'> = {
    depository: 'checking',
    credit: 'credit',
    investment: 'investment',
    loan: 'other',
    brokerage: 'investment',
  };
  return mapping[plaidType] || 'other';
}

async function syncTransactions(companyId: string, accessToken: string) {
  try {
    const client = await getPlaidClient();

    // Get accounts first
    const accountsResponse = await client.accountsGet({ access_token: accessToken });

    for (const account of accountsResponse.data.accounts) {
      // Update balance
      await prisma.bankAccount.update({
        where: { plaidAccountId: account.account_id },
        data: {
          currentBalance: BigInt(Math.round((account.balances.current || 0) * 100)),
          availableBalance: BigInt(Math.round((account.balances.available || 0) * 100)),
          lastSyncedAt: new Date(),
        },
      });
    }

    // Get transactions (last 30 days)
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    const transactionsResponse = await client.transactionsGet({
      access_token: accessToken,
      start_date: startDate.toISOString().split('T')[0],
      end_date: new Date().toISOString().split('T')[0],
    });

    for (const tx of transactionsResponse.data.transactions) {
      const bankAccount = await prisma.bankAccount.findUnique({
        where: { plaidAccountId: tx.account_id },
      });

      if (!bankAccount) continue;

      await prisma.transaction.upsert({
        where: { plaidTransactionId: tx.transaction_id },
        create: {
          bankAccountId: bankAccount.id,
          companyId,
          plaidTransactionId: tx.transaction_id,
          transactionDate: new Date(tx.date),
          amount: BigInt(Math.round(tx.amount * -100)), // Plaid uses positive for outflows
          categoryPrimary: tx.category?.[0],
          categoryDetailed: tx.category?.[1],
          merchantName: tx.merchant_name,
          description: tx.name,
          pending: tx.pending,
          paymentChannel: tx.payment_channel as any,
          transactionType: tx.amount > 0 ? 'outflow' : 'inflow',
        },
        update: {
          pending: tx.pending,
          categoryPrimary: tx.category?.[0],
          categoryDetailed: tx.category?.[1],
        },
      });
    }
  } catch (error) {
    console.error('Transaction sync error:', error);
    throw error;
  }
}

export default router;
