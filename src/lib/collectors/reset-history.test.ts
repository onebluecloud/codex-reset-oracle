import { describe, expect, it } from "vitest";

import { isFleetWideScope, parseResetHistory } from "./reset-history";

describe("parseResetHistory", () => {
  const payload = {
    recent_windows: [
      { opened_at: "2026-06-04T08:25:00+08:00", scope: "所有付费计划", title: "事故补偿重置" },
      { opened_at: "2026-05-23T08:21:00+08:00", scope: "Codex 用户", title: "Codex-only reset" },
      { opened_at: "2026-04-17T08:58:00+08:00", scope: "所有计划", title: "一周年重置" },
      { opened_at: "2026-04-09T10:31:00+08:00", scope: "现有 $200 Pro 用户", title: "Pro-only reset" },
      { opened_at: null, scope: "所有付费计划", title: "missing opened_at" },
      { opened_at: "not-a-date", scope: "所有计划", title: "bad date" },
      { scope: "所有计划", title: "no opened_at key" }
    ]
  };

  it("keeps only fleet-wide (所有) resets with a valid opened_at", () => {
    const resets = parseResetHistory(payload);
    expect(resets).toHaveLength(2);
    expect(resets.every((r) => r.kind === "reset")).toBe(true);
    // Normalized to UTC ISO.
    expect(resets[0].at).toBe(new Date("2026-06-04T08:25:00+08:00").toISOString());
    expect(resets[1].at).toBe(new Date("2026-04-17T08:58:00+08:00").toISOString());
  });

  it("returns [] for non-object payloads or a missing/bad recent_windows", () => {
    expect(parseResetHistory(null)).toEqual([]);
    expect(parseResetHistory({})).toEqual([]);
    expect(parseResetHistory({ recent_windows: "nope" })).toEqual([]);
    expect(parseResetHistory([1, 2, 3])).toEqual([]);
  });
});

describe("isFleetWideScope", () => {
  it("matches only 所有-scoped (fleet-wide) resets", () => {
    expect(isFleetWideScope("所有付费计划")).toBe(true);
    expect(isFleetWideScope("所有计划")).toBe(true);
    expect(isFleetWideScope("Codex 用户")).toBe(false);
    expect(isFleetWideScope("现有 $200 Pro 用户")).toBe(false);
    expect(isFleetWideScope(null)).toBe(false);
    expect(isFleetWideScope(123)).toBe(false);
  });
});
