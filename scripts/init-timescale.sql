-- CashFlow AI - TimescaleDB Initialization
-- Run after Prisma migrations to convert tables to hypertables

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Convert transactions to hypertable (after Prisma creates the table)
-- SELECT create_hypertable('transactions', by_range('transaction_date', INTERVAL '1 month'), if_not_exists => TRUE);

-- Convert forecasts to hypertable
-- SELECT create_hypertable('forecasts', by_range('forecast_date', INTERVAL '3 months'), if_not_exists => TRUE);

-- Convert working_capital_metrics to hypertable
-- SELECT create_hypertable('working_capital_metrics', by_range('metric_date', INTERVAL '1 month'), if_not_exists => TRUE);

-- Note: Run these commands manually after prisma migrate dev
-- The hypertable conversion requires the tables to exist first
