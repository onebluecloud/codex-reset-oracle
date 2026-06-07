import { normalizeStatusIncident } from "../normalize";
import type { CollectorStatus, Signal } from "../types";

type CollectorResult = {
  status: CollectorStatus;
  signals: Signal[];
};

type StatusPayload = {
  incidents?: unknown;
};

const STATUS_URL = "https://status.openai.com/api/v2/incidents.json";

export async function collectOpenAIStatusSignals(): Promise<CollectorResult> {
  try {
    const response = await fetch(STATUS_URL, {
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      return {
        status: {
          source: "openai-status",
          ok: false,
          message: `OpenAI Status collector failed with HTTP ${response.status}.`
        },
        signals: []
      };
    }

    const payload: unknown = await response.json();
    const statusPayload = asStatusPayload(payload);
    if (!statusPayload) {
      return {
        status: {
          source: "openai-status",
          ok: false,
          message: "OpenAI Status collector returned an unexpected JSON shape."
        },
        signals: []
      };
    }

    const rows = statusPayload.incidents;
    const signals = rows
      .map((row) => normalizeStatusIncident(row))
      .filter((signal): signal is Signal => Boolean(signal));
    const fetchedAt = new Date().toISOString();

    return {
      status: {
        source: "openai-status",
        ok: true,
        message: `Fetched ${signals.length} OpenAI Status signals.`,
        fetchedAt
      },
      signals
    };
  } catch (error) {
    return {
      status: {
        source: "openai-status",
        ok: false,
        message: `OpenAI Status collector failed: ${errorMessage(error)}`
      },
      signals: []
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function asStatusPayload(value: unknown): { incidents: unknown[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const payload = value as StatusPayload;
  return Array.isArray(payload.incidents) ? { incidents: payload.incidents } : null;
}
