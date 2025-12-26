# CashFlow AI

AI-powered cash flow forecasting SaaS for mid-market B2B companies.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (Next.js 14)                   │
│                   React 18 + Tailwind + Shadcn               │
│                        Port: 3000                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Backend API (Express.js)                   │
│              Node.js 20 + TypeScript + Prisma               │
│                        Port: 3001                            │
└─────────────────────────────────────────────────────────────┘
           │                                    │
           ▼                                    ▼
┌─────────────────────┐          ┌─────────────────────────────┐
│   ML Service        │          │        Data Layer           │
│   FastAPI + Prophet │          │  PostgreSQL + TimescaleDB   │
│   Port: 8001        │          │        + Redis              │
└─────────────────────┘          └─────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- Python 3.11+
- Docker & Docker Compose
- PostgreSQL 15 with TimescaleDB

### Development Setup

1. **Clone and install dependencies:**
   ```bash
   cd cashflow-ai
   npm install
   ```

2. **Start infrastructure:**
   ```bash
   npm run docker:up
   ```

3. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

4. **Run database migrations:**
   ```bash
   npm run db:migrate
   ```

5. **Start development servers:**
   ```bash
   npm run dev
   ```

   This starts:
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:3001
   - ML Service: http://localhost:8001

### Environment Variables

See `.env.example` for all required variables:

- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `JWT_SECRET` - JWT signing secret (min 32 chars)
- `PLAID_CLIENT_ID` / `PLAID_SECRET` - Plaid API credentials
- `STRIPE_SECRET_KEY` - Stripe API key

## Project Structure

```
cashflow-ai/
├── apps/
│   ├── web/                 # Next.js 14 frontend
│   │   ├── src/
│   │   │   ├── app/         # App Router pages
│   │   │   ├── components/  # React components
│   │   │   └── lib/         # Utilities and API client
│   │   └── package.json
│   │
│   ├── api/                 # Express backend
│   │   ├── src/
│   │   │   ├── routes/      # API endpoints
│   │   │   ├── services/    # Business logic
│   │   │   └── middleware/  # Auth, validation, etc.
│   │   └── prisma/          # Database schema
│   │
│   └── ml-service/          # Python ML service
│       ├── main.py          # FastAPI application
│       └── requirements.txt
│
├── packages/
│   └── shared/              # Shared types and utilities
│
├── docker-compose.yml       # Local development
└── turbo.json               # Monorepo config
```

## API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Create account
- `POST /api/v1/auth/login` - Login
- `POST /api/v1/auth/refresh` - Refresh token
- `POST /api/v1/auth/logout` - Logout
- `POST /api/v1/auth/mfa/setup` - Setup MFA
- `POST /api/v1/auth/mfa/verify` - Verify MFA

### Cash Position
- `GET /api/v1/cash-position/current` - Current balance
- `GET /api/v1/cash-position/history` - Balance history
- `GET /api/v1/cash-position/runway` - Cash runway

### Forecasts
- `GET /api/v1/forecasts` - Get forecasts
- `POST /api/v1/forecasts/generate` - Generate new forecast
- `GET /api/v1/forecasts/compare` - Compare scenarios

### Alerts
- `GET /api/v1/alerts` - List alerts
- `PUT /api/v1/alerts/:id/acknowledge` - Acknowledge alert

### Integrations
- `POST /api/v1/integrations/plaid/link-token` - Get Plaid Link token
- `POST /api/v1/integrations/plaid/exchange` - Exchange public token

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14 (App Router) |
| UI Components | Shadcn UI + Tailwind CSS |
| State Management | Zustand + React Query |
| Backend | Node.js + Express + TypeScript |
| ORM | Prisma 5 |
| Database | PostgreSQL 15 + TimescaleDB |
| Cache | Redis 7 |
| ML | Python + FastAPI + Prophet |
| Auth | JWT + bcrypt + MFA (TOTP) |

## Security Features

- JWT authentication with refresh tokens
- MFA support (TOTP-based)
- bcrypt password hashing (cost factor 12)
- Rate limiting on auth endpoints
- Input validation with Zod
- RBAC with 5 role levels
- Encrypted Plaid tokens

## License

Proprietary - CashFlow AI
