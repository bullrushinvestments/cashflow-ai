import axios from "axios";
import { useAuthStore } from "./store/auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  headers: {
    "Content-Type": "application/json",
  },
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const { accessToken } = useAuthStore.getState();
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// Handle token refresh on 401
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      const { refreshToken, setTokens, logout } = useAuthStore.getState();

      if (!refreshToken) {
        logout();
        window.location.href = "/login";
        return Promise.reject(error);
      }

      try {
        const response = await axios.post(`${API_URL}/api/v1/auth/refresh`, {
          refreshToken,
        });

        const { accessToken: newAccessToken, refreshToken: newRefreshToken } =
          response.data;

        setTokens(newAccessToken, newRefreshToken);
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;

        return api(originalRequest);
      } catch (refreshError) {
        logout();
        window.location.href = "/login";
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

// Auth API
export const authApi = {
  login: async (email: string, password: string, mfaCode?: string) => {
    const response = await api.post("/auth/login", { email, password, mfaCode });
    return response.data;
  },

  register: async (data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    companyName: string;
    industry: string;
    employeeCount: number;
    annualRevenue: number;
  }) => {
    const response = await api.post("/auth/register", data);
    return response.data;
  },

  logout: async (refreshToken: string) => {
    await api.post("/auth/logout", { refreshToken });
  },

  getMe: async () => {
    const response = await api.get("/users/me");
    return response.data;
  },
};

// Cash Position API
export const cashPositionApi = {
  getCurrent: async () => {
    const response = await api.get("/cash-position/current");
    return response.data;
  },

  getHistory: async (params?: { startDate?: string; endDate?: string; granularity?: string }) => {
    const response = await api.get("/cash-position/history", { params });
    return response.data;
  },

  getInflowsOutflows: async (period?: string) => {
    const response = await api.get("/cash-position/inflows-outflows", {
      params: { period },
    });
    return response.data;
  },

  getRunway: async () => {
    const response = await api.get("/cash-position/runway");
    return response.data;
  },
};

// Forecasts API
export const forecastsApi = {
  getForecasts: async (scenario?: string) => {
    const response = await api.get("/forecasts", { params: { scenario } });
    return response.data;
  },

  generateForecast: async (horizonDays?: number) => {
    const response = await api.post("/forecasts/generate", { horizonDays });
    return response.data;
  },

  getCompare: async () => {
    const response = await api.get("/forecasts/compare");
    return response.data;
  },
};

// Alerts API
export const alertsApi = {
  getAlerts: async (params?: { status?: string; severity?: string }) => {
    const response = await api.get("/alerts", { params });
    return response.data;
  },

  getSummary: async () => {
    const response = await api.get("/alerts/summary");
    return response.data;
  },

  acknowledge: async (id: string) => {
    const response = await api.put(`/alerts/${id}/acknowledge`);
    return response.data;
  },

  dismiss: async (id: string) => {
    const response = await api.put(`/alerts/${id}/dismiss`);
    return response.data;
  },
};

// Transactions API
export const transactionsApi = {
  getTransactions: async (params?: {
    page?: number;
    limit?: number;
    category?: string;
    type?: string;
  }) => {
    const response = await api.get("/transactions", { params });
    return response.data;
  },

  getCategories: async () => {
    const response = await api.get("/transactions/categories");
    return response.data;
  },
};

// Integrations API
export const integrationsApi = {
  getIntegrations: async () => {
    const response = await api.get("/integrations");
    return response.data;
  },

  createPlaidLinkToken: async () => {
    const response = await api.post("/integrations/plaid/link-token");
    return response.data;
  },

  exchangePlaidToken: async (publicToken: string, metadata: any) => {
    const response = await api.post("/integrations/plaid/exchange", {
      publicToken,
      metadata,
    });
    return response.data;
  },
};
