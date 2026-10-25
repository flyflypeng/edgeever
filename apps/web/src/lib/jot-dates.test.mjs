import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildMonthGrid, getJotHeatLevel, localDayRange, parseLocalDayKey, shiftMonth, toLocalDayKey } from "./jot-dates.ts";

// Bun honours runtime changes to process.env.TZ; pin a zone with DST transitions.
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe("toLocalDayKey", () => {
  test("uses the local calendar day, not the UTC day", () => {
    // 03:30 UTC on Jan 2 is still Jan 1 in New York (UTC-5).
    expect(toLocalDayKey("2024-01-02T03:30:00.000Z")).toBe("2024-01-01");
    expect(toLocalDayKey("2024-01-02T05:00:00.000Z")).toBe("2024-01-02");
  });

  test("returns an empty string for invalid input", () => {
    expect(toLocalDayKey("not a date")).toBe("");
  });

  test("round-trips through localDayRange", () => {
    const { createdFrom, createdTo } = localDayRange("2024-07-04");
    expect(toLocalDayKey(createdFrom)).toBe("2024-07-04");
    expect(toLocalDayKey(new Date(new Date(createdTo).getTime() - 1).toISOString())).toBe("2024-07-04");
  });
});

describe("localDayRange", () => {
  test("covers local midnight to next local midnight", () => {
    expect(localDayRange("2024-01-15")).toEqual({
      createdFrom: "2024-01-15T05:00:00.000Z",
      createdTo: "2024-01-16T05:00:00.000Z",
    });
  });

  test("crosses month and year boundaries", () => {
    expect(localDayRange("2024-01-31").createdTo).toBe(new Date(2024, 1, 1).toISOString());
    expect(localDayRange("2023-12-31")).toEqual({
      createdFrom: "2023-12-31T05:00:00.000Z",
      createdTo: "2024-01-01T05:00:00.000Z",
    });
  });

  test("handles leap days", () => {
    expect(localDayRange("2024-02-28").createdTo).toBe(new Date(2024, 1, 29).toISOString());
    expect(localDayRange("2024-02-29")).toEqual({
      createdFrom: "2024-02-29T05:00:00.000Z",
      createdTo: "2024-03-01T05:00:00.000Z",
    });
    expect(() => localDayRange("2023-02-29")).toThrow(RangeError);
  });

  test("spring-forward day is 23 hours long", () => {
    const { createdFrom, createdTo } = localDayRange("2024-03-10");
    expect(createdFrom).toBe("2024-03-10T05:00:00.000Z");
    expect(createdTo).toBe("2024-03-11T04:00:00.000Z");
    expect(new Date(createdTo).getTime() - new Date(createdFrom).getTime()).toBe(23 * 3_600_000);
  });

  test("fall-back day is 25 hours long", () => {
    const { createdFrom, createdTo } = localDayRange("2024-11-03");
    expect(createdFrom).toBe("2024-11-03T04:00:00.000Z");
    expect(createdTo).toBe("2024-11-04T05:00:00.000Z");
    expect(new Date(createdTo).getTime() - new Date(createdFrom).getTime()).toBe(25 * 3_600_000);
  });

  test("rejects malformed keys", () => {
    expect(() => localDayRange("2024-1-5")).toThrow(RangeError);
    expect(() => localDayRange("2024-13-01")).toThrow(RangeError);
    expect(parseLocalDayKey("2024-04-31")).toBeNull();
  });
});

describe("buildMonthGrid", () => {
  test("starts on Monday and pads both sides", () => {
    // February 2024 starts on Thursday and ends on Thursday (leap year, 29 days).
    const cells = buildMonthGrid({ year: 2024, monthIndex: 1 });
    expect(cells.length).toBe(35);
    expect(cells.slice(0, 4).map((cell) => cell.key)).toEqual(["2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01"]);
    expect(cells[0].inMonth).toBe(false);
    expect(cells[3]).toEqual({ key: "2024-02-01", day: 1, inMonth: true });
    expect(cells.filter((cell) => cell.inMonth).length).toBe(29);
    expect(cells.at(-1)).toEqual({ key: "2024-03-03", day: 3, inMonth: false });
  });

  test("has no leading padding when the month starts on Monday", () => {
    // April 2024 starts on Monday; 30 days → 35 cells.
    const cells = buildMonthGrid({ year: 2024, monthIndex: 3 });
    expect(cells[0]).toEqual({ key: "2024-04-01", day: 1, inMonth: true });
    expect(cells.length).toBe(35);
  });

  test("keeps the DST month contiguous", () => {
    const cells = buildMonthGrid({ year: 2024, monthIndex: 2 });
    const index = cells.findIndex((cell) => cell.key === "2024-03-10");
    expect(cells[index + 1].key).toBe("2024-03-11");
    expect(cells.length % 7).toBe(0);
  });
});

describe("shiftMonth", () => {
  test("wraps across years", () => {
    expect(shiftMonth({ year: 2024, monthIndex: 0 }, -1)).toEqual({ year: 2023, monthIndex: 11 });
    expect(shiftMonth({ year: 2024, monthIndex: 11 }, 1)).toEqual({ year: 2025, monthIndex: 0 });
  });
});

describe("getJotHeatLevel", () => {
  test("maps counts into three tiers", () => {
    expect([0, 1, 2, 3, 5, 6, 40].map(getJotHeatLevel)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });
});
