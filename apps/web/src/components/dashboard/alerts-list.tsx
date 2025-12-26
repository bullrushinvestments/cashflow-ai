"use client";

import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { AlertTriangle, Info, AlertCircle } from "lucide-react";

interface Alert {
  id: string;
  alertType: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  createdAt: string;
}

interface AlertsListProps {
  alerts: Alert[];
}

const severityConfig = {
  info: {
    icon: Info,
    bgColor: "bg-blue-50",
    textColor: "text-blue-600",
    borderColor: "border-blue-200",
  },
  warning: {
    icon: AlertTriangle,
    bgColor: "bg-orange-50",
    textColor: "text-orange-600",
    borderColor: "border-orange-200",
  },
  critical: {
    icon: AlertCircle,
    bgColor: "bg-red-50",
    textColor: "text-red-600",
    borderColor: "border-red-200",
  },
};

export function AlertsList({ alerts }: AlertsListProps) {
  if (alerts.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No active alerts. Your cash flow looks healthy!
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {alerts.map((alert) => {
        const config = severityConfig[alert.severity];
        const Icon = config.icon;

        return (
          <div
            key={alert.id}
            className={cn(
              "p-3 rounded-lg border",
              config.bgColor,
              config.borderColor
            )}
          >
            <div className="flex items-start gap-3">
              <Icon className={cn("h-5 w-5 mt-0.5", config.textColor)} />
              <div className="flex-1 min-w-0">
                <p className={cn("font-medium text-sm", config.textColor)}>
                  {alert.title}
                </p>
                <p className="text-sm text-gray-600 mt-0.5 line-clamp-2">
                  {alert.message}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {formatDate(alert.createdAt)}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
