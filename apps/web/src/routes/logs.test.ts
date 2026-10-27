import { getLogSearchText, getVisualLogLevel, getVisualLogLevelLabel, projectLogEntryLevel } from "@mdcz/shared";
import { describe, expect, it } from "vitest";

describe("shared log formatting for web logs", () => {
  it("projects task completion logs to OK labels", () => {
    const log = {
      id: "log-1",
      createdAt: "2026-05-12T00:00:00.000Z",
      message: "Scrape completed. Succeeded: 1, Failed: 0",
      source: "task" as const,
      taskId: "task-1",
      type: "completed",
    };

    expect(projectLogEntryLevel(log)).toBe("OK");
    expect(getVisualLogLevelLabel(getVisualLogLevel(log))).toBe("OK");
    expect(getLogSearchText(log)).toContain("ok");
  });
});
