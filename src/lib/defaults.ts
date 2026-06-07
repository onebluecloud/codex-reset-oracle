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
  degraded: 0.25,
  incident: 0.2,
  mitigated: 0.2,
  recovery: 0.25,
  queue: 0.15
};

export const REFRESH_MINUTES_DEFAULT = 45;
export const MAX_SIGNALS = 60;
