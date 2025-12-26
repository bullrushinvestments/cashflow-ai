"""
CashFlow AI - ML Forecasting Service
FastAPI service for cash flow prediction using Prophet
"""

import os
import logging
from datetime import datetime, timedelta
from typing import Optional
from contextlib import asynccontextmanager

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
from prophet import Prophet
from sklearn.ensemble import IsolationForest
import redis.asyncio as redis
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
import httpx

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    database_url: str = "postgresql://cashflow:password@localhost:5432/cashflow_ai"
    redis_url: str = "redis://localhost:6379"
    api_url: str = "http://localhost:3001"
    model_version: str = "1.0.0"

    class Config:
        env_file = ".env"


settings = Settings()

# Database setup
engine = create_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine)

# Redis client
redis_client: Optional[redis.Redis] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events"""
    global redis_client
    redis_client = redis.from_url(settings.redis_url)
    logger.info("ML Service started")
    yield
    if redis_client:
        await redis_client.close()
    logger.info("ML Service stopped")


app = FastAPI(
    title="CashFlow AI ML Service",
    description="Machine learning service for cash flow forecasting",
    version="1.0.0",
    lifespan=lifespan,
)


# Request/Response Models
class ForecastRequest(BaseModel):
    forecast_run_id: str = Field(..., alias="forecastRunId")
    company_id: str = Field(..., alias="companyId")
    horizon_days: int = Field(default=90, alias="horizonDays", ge=7, le=365)


class ForecastResponse(BaseModel):
    forecast_run_id: str
    status: str
    message: str


class AnomalyRequest(BaseModel):
    company_id: str = Field(..., alias="companyId")
    transaction_ids: list[str] = Field(default=[], alias="transactionIds")


class AnomalyResponse(BaseModel):
    anomalies: list[dict]
    total_analyzed: int


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    model_version: str


# Health check
@app.get("/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(
        status="healthy",
        timestamp=datetime.utcnow().isoformat(),
        model_version=settings.model_version,
    )


# Forecast endpoint
@app.post("/forecast", response_model=ForecastResponse)
async def generate_forecast(
    request: ForecastRequest,
    background_tasks: BackgroundTasks,
):
    """
    Trigger forecast generation for a company.
    The forecast is generated asynchronously in the background.
    """
    logger.info(f"Forecast requested for company {request.company_id}")

    # Add to background tasks
    background_tasks.add_task(
        run_forecast_pipeline,
        request.forecast_run_id,
        request.company_id,
        request.horizon_days,
    )

    return ForecastResponse(
        forecast_run_id=request.forecast_run_id,
        status="processing",
        message="Forecast generation started",
    )


async def run_forecast_pipeline(
    forecast_run_id: str,
    company_id: str,
    horizon_days: int,
):
    """Execute the full forecast pipeline"""
    start_time = datetime.utcnow()

    try:
        with SessionLocal() as session:
            # Update status to processing
            session.execute(
                text("""
                    UPDATE forecast_runs
                    SET status = 'processing'
                    WHERE id = :run_id
                """),
                {"run_id": forecast_run_id},
            )
            session.commit()

            # Fetch transaction data
            transactions = fetch_transactions(session, company_id)

            if len(transactions) < 90:
                raise ValueError("Insufficient transaction history (need 90+ days)")

            # Prepare data for Prophet
            df = prepare_prophet_data(transactions)

            # Generate forecasts for each scenario
            scenarios = ["pessimistic", "baseline", "optimistic"]
            accuracy_metrics = {}

            for scenario in scenarios:
                forecasts = generate_prophet_forecast(
                    df, horizon_days, scenario
                )

                # Store forecasts
                store_forecasts(
                    session,
                    forecast_run_id,
                    company_id,
                    forecasts,
                    scenario,
                )

                # Calculate accuracy metrics for baseline
                if scenario == "baseline":
                    accuracy_metrics = calculate_accuracy(df, forecasts)

            # Update run as completed
            processing_time = int((datetime.utcnow() - start_time).total_seconds() * 1000)

            session.execute(
                text("""
                    UPDATE forecast_runs
                    SET status = 'completed',
                        completed_at = NOW(),
                        processing_time_ms = :time_ms,
                        accuracy_metrics = :metrics::jsonb
                    WHERE id = :run_id
                """),
                {
                    "run_id": forecast_run_id,
                    "time_ms": processing_time,
                    "metrics": str(accuracy_metrics).replace("'", '"'),
                },
            )
            session.commit()

            logger.info(f"Forecast completed for run {forecast_run_id} in {processing_time}ms")

            # Generate alerts from forecast
            await generate_forecast_alerts(session, company_id, forecast_run_id)

    except Exception as e:
        logger.error(f"Forecast failed: {e}")
        with SessionLocal() as session:
            session.execute(
                text("""
                    UPDATE forecast_runs
                    SET status = 'failed',
                        error_message = :error
                    WHERE id = :run_id
                """),
                {"run_id": forecast_run_id, "error": str(e)},
            )
            session.commit()


def fetch_transactions(session, company_id: str) -> pd.DataFrame:
    """Fetch transaction history for a company"""
    result = session.execute(
        text("""
            SELECT
                transaction_date::date as ds,
                SUM(amount) as amount
            FROM transactions
            WHERE company_id = :company_id
            GROUP BY transaction_date::date
            ORDER BY ds
        """),
        {"company_id": company_id},
    )

    rows = result.fetchall()
    df = pd.DataFrame(rows, columns=["ds", "amount"])
    df["amount"] = df["amount"].astype(float) / 100  # Convert cents to dollars
    return df


def prepare_prophet_data(df: pd.DataFrame) -> pd.DataFrame:
    """Prepare data for Prophet model"""
    # Prophet expects 'ds' and 'y' columns
    df = df.copy()
    df["ds"] = pd.to_datetime(df["ds"])

    # Calculate cumulative balance (running sum)
    df["y"] = df["amount"].cumsum()

    return df[["ds", "y"]]


def generate_prophet_forecast(
    df: pd.DataFrame,
    horizon_days: int,
    scenario: str,
) -> pd.DataFrame:
    """Generate forecast using Prophet"""

    # Adjust parameters based on scenario
    interval_width = {
        "pessimistic": 0.95,  # Wide intervals
        "baseline": 0.80,
        "optimistic": 0.65,  # Narrow intervals
    }[scenario]

    changepoint_scale = {
        "pessimistic": 0.1,  # More conservative
        "baseline": 0.05,
        "optimistic": 0.02,  # More stable
    }[scenario]

    # Initialize and fit Prophet model
    model = Prophet(
        interval_width=interval_width,
        changepoint_prior_scale=changepoint_scale,
        yearly_seasonality=True,
        weekly_seasonality=True,
        daily_seasonality=False,
    )

    model.fit(df)

    # Create future dataframe
    future = model.make_future_dataframe(periods=horizon_days)

    # Generate predictions
    forecast = model.predict(future)

    # Return only future predictions
    forecast = forecast[forecast["ds"] > df["ds"].max()]

    return forecast[["ds", "yhat", "yhat_lower", "yhat_upper"]]


def store_forecasts(
    session,
    forecast_run_id: str,
    company_id: str,
    forecasts: pd.DataFrame,
    scenario: str,
):
    """Store forecast results in database"""
    for _, row in forecasts.iterrows():
        # Calculate daily inflow/outflow from balance change
        predicted_balance = int(row["yhat"] * 100)  # Convert to cents
        confidence_lower = int(row["yhat_lower"] * 100)
        confidence_upper = int(row["yhat_upper"] * 100)

        session.execute(
            text("""
                INSERT INTO forecasts (
                    id, company_id, forecast_run_id, forecast_date,
                    predicted_balance, predicted_inflow, predicted_outflow,
                    confidence_lower, confidence_upper, confidence_level,
                    scenario, model_version, created_at
                ) VALUES (
                    gen_random_uuid(), :company_id, :run_id, :forecast_date,
                    :balance, :inflow, :outflow,
                    :lower, :upper, 0.80,
                    :scenario, :version, NOW()
                )
            """),
            {
                "company_id": company_id,
                "run_id": forecast_run_id,
                "forecast_date": row["ds"],
                "balance": predicted_balance,
                "inflow": max(0, predicted_balance),  # Simplified
                "outflow": abs(min(0, predicted_balance)),  # Simplified
                "lower": confidence_lower,
                "upper": confidence_upper,
                "scenario": scenario,
                "version": settings.model_version,
            },
        )

    session.commit()


def calculate_accuracy(
    historical: pd.DataFrame,
    forecast: pd.DataFrame,
) -> dict:
    """Calculate forecast accuracy metrics using holdout validation"""
    # Use last 30 days of historical as validation set
    if len(historical) < 120:
        return {"mape": None, "rmse": None, "mae": None}

    train = historical.iloc[:-30]
    test = historical.iloc[-30:]

    # Fit model on training data
    model = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=True,
    )
    model.fit(train)

    # Predict on test period
    future = model.make_future_dataframe(periods=30)
    predictions = model.predict(future)
    predictions = predictions[predictions["ds"].isin(test["ds"])]

    # Calculate metrics
    if len(predictions) == 0:
        return {"mape": None, "rmse": None, "mae": None}

    y_true = test["y"].values
    y_pred = predictions["yhat"].values[:len(y_true)]

    mape = np.mean(np.abs((y_true - y_pred) / y_true)) * 100
    rmse = np.sqrt(np.mean((y_true - y_pred) ** 2))
    mae = np.mean(np.abs(y_true - y_pred))

    return {
        "mape": round(mape, 2),
        "rmse": round(rmse, 2),
        "mae": round(mae, 2),
    }


async def generate_forecast_alerts(session, company_id: str, forecast_run_id: str):
    """Generate alerts based on forecast results"""
    # Get forecast data
    result = session.execute(
        text("""
            SELECT forecast_date, predicted_balance, confidence_lower
            FROM forecasts
            WHERE forecast_run_id = :run_id AND scenario = 'baseline'
            ORDER BY forecast_date
        """),
        {"run_id": forecast_run_id},
    )
    forecasts = result.fetchall()

    # Get current balance
    balance_result = session.execute(
        text("""
            SELECT SUM(current_balance) as balance
            FROM bank_accounts
            WHERE company_id = :company_id AND is_active = true
        """),
        {"company_id": company_id},
    )
    current_balance = balance_result.scalar() or 0

    # Check for cash shortage alerts
    for date, predicted, lower in forecasts:
        # Alert if predicted balance drops significantly
        if predicted < current_balance * 0.2:  # 80% drop
            session.execute(
                text("""
                    INSERT INTO alerts (
                        id, company_id, alert_type, severity,
                        title, message, predicted_date, predicted_amount,
                        status, created_at
                    ) VALUES (
                        gen_random_uuid(), :company_id, 'cash_shortage', 'critical',
                        'Low Cash Balance Predicted',
                        'Forecast indicates cash balance may drop to critically low levels.',
                        :date, :amount, 'active', NOW()
                    )
                    ON CONFLICT DO NOTHING
                """),
                {
                    "company_id": company_id,
                    "date": date,
                    "amount": predicted,
                },
            )
            break  # Only create one alert

    session.commit()


# Anomaly detection endpoint
@app.post("/anomalies", response_model=AnomalyResponse)
async def detect_anomalies(request: AnomalyRequest):
    """Detect anomalous transactions using Isolation Forest"""
    with SessionLocal() as session:
        # Fetch transactions
        if request.transaction_ids:
            result = session.execute(
                text("""
                    SELECT id, amount, transaction_date, category_primary
                    FROM transactions
                    WHERE company_id = :company_id
                    AND id = ANY(:ids)
                """),
                {
                    "company_id": request.company_id,
                    "ids": request.transaction_ids,
                },
            )
        else:
            result = session.execute(
                text("""
                    SELECT id, amount, transaction_date, category_primary
                    FROM transactions
                    WHERE company_id = :company_id
                    ORDER BY transaction_date DESC
                    LIMIT 1000
                """),
                {"company_id": request.company_id},
            )

        rows = result.fetchall()

        if len(rows) < 100:
            return AnomalyResponse(anomalies=[], total_analyzed=len(rows))

        # Prepare features
        df = pd.DataFrame(rows, columns=["id", "amount", "date", "category"])
        df["amount_abs"] = df["amount"].abs() / 100
        df["day_of_week"] = pd.to_datetime(df["date"]).dt.dayofweek

        features = df[["amount_abs", "day_of_week"]].values

        # Fit Isolation Forest
        model = IsolationForest(
            contamination=0.05,  # Expect 5% anomalies
            random_state=42,
        )
        predictions = model.fit_predict(features)

        # Get anomalies
        anomaly_indices = np.where(predictions == -1)[0]
        anomalies = []

        for idx in anomaly_indices:
            row = df.iloc[idx]
            anomalies.append({
                "transactionId": row["id"],
                "amount": float(row["amount"]) / 100,
                "date": str(row["date"]),
                "category": row["category"],
                "score": float(model.score_samples(features[idx:idx+1])[0]),
            })

        return AnomalyResponse(
            anomalies=anomalies,
            total_analyzed=len(rows),
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
