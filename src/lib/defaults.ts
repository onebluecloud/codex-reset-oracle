export const WATCHED_ACCOUNTS = [
  { handle: "thsottiaux", label: "Tibo", weight: 1 },
  { handle: "OpenAI", label: "OpenAI", weight: 1 },
  { handle: "OpenAIDevs", label: "OpenAI Developers", weight: 0.95 },
  { handle: "sama", label: "Sam Altman", weight: 0.6 },
  { handle: "gdb", label: "Greg Brockman", weight: 0.6 },
  { handle: "btibor91", label: "Tibor Blaho", weight: 0.35 }
] as const;

export const KEYWORD_WEIGHTS: Record<string, number> = {
  codex: 0.2,
  reset: 0.35,
  quota: 0.35,
  limit: 0.3,
  limits: 0.3,
  capacity: 0.3,
  usage: 0.25,
  // Incident-compensation precursors. 4 of the last 10 resets were "we had an
  // incident, so we reset everyone's limits", so a fresh outage/degradation is a
  // strong near-term reset signal — weighted up, plus the compensation vocabulary
  // that tends to precede the reset announcement itself.
  degraded: 0.3,
  incident: 0.3,
  outage: 0.3,
  mitigated: 0.25,
  recovery: 0.3,
  restored: 0.25,
  compensate: 0.3,
  compensation: 0.3,
  queue: 0.15
};

export const REFRESH_MINUTES_DEFAULT = 45;
export const MAX_SIGNALS = 60;
