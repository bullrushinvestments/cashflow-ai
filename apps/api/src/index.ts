import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';

// Route imports
import authRoutes from './routes/auth';
import usersRoutes from './routes/users';
import companiesRoutes from './routes/companies';
import bankAccountsRoutes from './routes/bankAccounts';
import transactionsRoutes from './routes/transactions';
import forecastsRoutes from './routes/forecasts';
import alertsRoutes from './routes/alerts';
import integrationsRoutes from './routes/integrations';
import cashPositionRoutes from './routes/cashPosition';
import workingCapitalRoutes from './routes/workingCapital';

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: config.corsOrigins,
  credentials: true,
}));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: { error: 'Too many authentication attempts, please try again later' },
});

// General rate limiting
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
});

app.use(generalLimiter);
app.use(express.json({ limit: '10mb' }));
app.use(requestLogger);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/companies', companiesRoutes);
app.use('/api/v1/bank-accounts', bankAccountsRoutes);
app.use('/api/v1/transactions', transactionsRoutes);
app.use('/api/v1/forecasts', forecastsRoutes);
app.use('/api/v1/alerts', alertsRoutes);
app.use('/api/v1/integrations', integrationsRoutes);
app.use('/api/v1/cash-position', cashPositionRoutes);
app.use('/api/v1/working-capital', workingCapitalRoutes);

// Error handling
app.use(errorHandler);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(config.port, () => {
  console.log(`CashFlow AI API running on port ${config.port}`);
  console.log(`Environment: ${config.nodeEnv}`);
});

export default app;
