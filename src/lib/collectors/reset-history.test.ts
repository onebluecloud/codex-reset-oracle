import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyResetDriver,
  collectResetHistory,
  isFleetWideScope,
  parseMilestones,
  parseResetDetails,
  parseResetHistory
} from "./reset-history";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("collectResetHistory failure semantics", () => {
  const jsonResponse = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" }
    });

  it("flags fetch errors and HTTP failures as ok:false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    expect((await collectResetHistory()).ok).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 502)));
    expect((await collectResetHistory()).ok).toBe(false);
  });

  it("flags a missing/reshaped recent_windows as ok:false, never an empty history", async () => {
    // An upstream schema change must read as "failed", or resolution would
    // mislabel every due prediction as a non-reset.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ totally: "different" })));
    expect((await collectResetHistory()).ok).toBe(false);
  });

  it("returns ok:true for a healthy payload, even with zero fleet-wide resets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          recent_windows: [
            { opened_at: "2026-05-23T08:21:00+08:00", scope: "Codex 用户", title: "Codex-only" }
          ]
        })
      )
    );
    const history = await collectResetHistory();
    expect(history.ok).toBe(true);
    expect(history.resets).toEqual([]);
  });
});

describe("parseResetDetails", () => {
  it("returns fleet-wide resets with title, scope, and driver classification", () => {
    const details = parseResetDetails({
      recent_windows: [
        {
          opened_at: "2026-06-04T08:25:00+08:00",
          scope: "所有付费计划",
          title: "Codex 可靠性事故补偿重置",
          summary: "三次小事故后重置。"
        },
        {
          opened_at: "2026-05-31T13:59:00+08:00",
          scope: "所有付费计划",
          title: "500 万用户庆祝重置",
          summary: "庆祝 Codex 达到 500 万用户。"
        },
        { opened_at: "2026-05-23T08:21:00+08:00", scope: "Codex 用户", title: "Codex-only" }
      ]
    });

    expect(details).toHaveLength(2);
    expect(details[0]).toMatchObject({ kind: "incident", scope: "所有付费计划" });
    expect(details[0].title).toMatch(/事故补偿/);
    // 里程碑分类优先于庆祝 — "万用户" 命中 milestone 规则。
    expect(details[1].kind).toBe("milestone");
  });
});

describe("classifyResetDriver", () => {
  it("classifies incident / milestone / celebration / other drivers", () => {
    expect(classifyResetDriver("Codex 可靠性事故补偿重置")).toBe("incident");
    expect(classifyResetDriver("Compensation for the outage")).toBe("incident");
    expect(classifyResetDriver("400 万活跃用户里程碑重置")).toBe("milestone");
    expect(classifyResetDriver("Celebrating 5M WAU")).toBe("milestone");
    expect(classifyResetDriver("感谢用户庆祝重置")).toBe("celebration");
    expect(classifyResetDriver("一周年重置")).toBe("other");
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

describe("parseMilestones", () => {
  const payload = {
    recent_windows: [
      {
        opened_at: "2026-05-31T13:59:00+08:00",
        scope: "所有付费计划",
        title: "500 万用户庆祝重置",
        summary: "庆祝 Codex 达到 500 万用户。"
      },
      {
        opened_at: "2026-04-21T22:52:00+08:00",
        scope: "Codex 用户",
        title: "400 万活跃用户里程碑重置",
        summary: "Codex 达到 400 万活跃用户后。"
      },
      {
        opened_at: "2026-04-09T10:31:00+08:00",
        scope: "现有 $200 Pro 用户",
        title: "300 万周活用户与新计划重置",
        summary: "Codex 达到 300 万周活用户。"
      },
      {
        opened_at: "2026-06-04T08:25:00+08:00",
        scope: "所有付费计划",
        title: "Codex 可靠性事故补偿重置",
        summary: "三次小事故后重置，无里程碑。"
      }
    ]
  };

  it("extracts user-count milestones (any scope) sorted ascending by count", () => {
    const ms = parseMilestones(payload);
    expect(ms.map((m) => m.countM)).toEqual([3, 4, 5]);
    expect(ms[2].at).toBe(new Date("2026-05-31T13:59:00+08:00").toISOString());
  });

  it("returns [] when no window mentions a user-count milestone", () => {
    expect(
      parseMilestones({
        recent_windows: [
          { opened_at: "2026-06-04T08:25:00+08:00", scope: "所有付费计划", title: "事故补偿", summary: "无里程碑" }
        ]
      })
    ).toEqual([]);
    expect(parseMilestones(null)).toEqual([]);
  });
});
