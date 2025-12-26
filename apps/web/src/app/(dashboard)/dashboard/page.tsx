"use client";

import { useQuery } from "@tanstack/react-query";
import { cashPositionApi, forecastsApi, alertsApi } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CashPositionChart } from "@/components/dashboard/cash-position-chart";
import { AlertsList } from "@/components/dashboard/alerts-list";
import { MetricCard } from "@/components/dashboard/metric-card";
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";

export default function DashboardPage() {
  const { data: cashPosition, isLoading: cashLoading } = useQuery({
    queryKey: ["cash-position"],
    queryFn: cashPositionApi.getCurrent,
  });

  const { data: runway, isLoading: runwayLoading } = useQuery({
    queryKey: ["runway"],
    queryFn: cashPositionApi.getRunway,
  });

  const { data: flows, isLoading: flowsLoading } = useQuery({
    queryKey: ["inflows-outflows"],
    queryFn: () => cashPositionApi.getInflowsOutflows("30d"),
  });

  const { data: alertSummary } = useQuery({
    queryKey: ["alerts-summary"],
    queryFn: alertsApi.getSummary,
  });

  const { data: alerts } = useQuery({
    queryKey: ["alerts", { status: "active" }],
    queryFn: () => alertsApi.getAlerts({ status: "active" }),
  });

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Your cash flow overview at a glance
        </p>
      </div>

      {/* Key Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Current Cash Position"
          value={cashLoading ? "..." : formatCurrency(cashPosition?.totalBalance || 0)}
          icon={DollarSign}
          description={`Across ${cashPosition?.accounts?.length || 0} accounts`}
        />
        <MetricCard
          title="30-Day Inflows"
          value={flowsLoading ? "..." : formatCurrency(flows?.inflows?.total || 0)}
          icon={ArrowUpRight}
          trend="up"
          trendValue={`${flows?.inflows?.count || 0} transactions`}
        />
        <MetricCard
          title="30-Day Outflows"
          value={flowsLoading ? "..." : formatCurrency(flows?.outflows?.total || 0)}
          icon={ArrowDownRight}
          trend="down"
          trendValue={`${flows?.outflows?.count || 0} transactions`}
        />
        <MetricCard
          title="Cash Runway"
          value={runwayLoading ? "..." : `${runway?.runwayMonths?.toFixed(1) || "N/A"} months`}
          icon={TrendingUp}
          description={runway?.avgMonthlyBurn ? `Burn: ${formatCurrency(runway.avgMonthlyBurn)}/mo` : ""}
        />
      </div>

      {/* Active Alerts */}
      {(alertSummary?.bySeverity?.critical > 0 || alertSummary?.bySeverity?.warning > 0) && (
        <Card className="border-orange-200 bg-orange-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-orange-500" />
              Active Alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4">
              {alertSummary?.bySeverity?.critical > 0 && (
                <span className="text-red-600 font-medium">
                  {alertSummary.bySeverity.critical} critical
                </span>
              )}
              {alertSummary?.bySeverity?.warning > 0 && (
                <span className="text-orange-600 font-medium">
                  {alertSummary.bySeverity.warning} warning
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Cash Position Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <CashPositionChart />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Alerts</CardTitle>
          </CardHeader>
          <CardContent>
            <AlertsList alerts={alerts?.data?.slice(0, 5) || []} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
