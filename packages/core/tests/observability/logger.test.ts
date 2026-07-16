import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConsoleLogger } from "../../src/observability/logger.js";

describe("ConsoleLogger", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should log debug messages to console.debug", () => {
    const logger = new ConsoleLogger();
    logger.debug("test message");
    expect(debugSpy).toHaveBeenCalledOnce();
    expect(debugSpy.mock.calls[0][0]).toContain("DEBUG");
    expect(debugSpy.mock.calls[0][0]).toContain("test message");
  });

  it("should log info messages to console.info", () => {
    const logger = new ConsoleLogger();
    logger.info("info msg");
    expect(infoSpy).toHaveBeenCalledOnce();
    expect(infoSpy.mock.calls[0][0]).toContain("INFO");
    expect(infoSpy.mock.calls[0][0]).toContain("info msg");
  });

  it("should log warn messages to console.warn", () => {
    const logger = new ConsoleLogger();
    logger.warn("warning");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("WARN");
    expect(warnSpy.mock.calls[0][0]).toContain("warning");
  });

  it("should log error messages to console.error", () => {
    const logger = new ConsoleLogger();
    logger.error("failure");
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("ERROR");
    expect(errorSpy.mock.calls[0][0]).toContain("failure");
  });

  it("should include a timestamp in ISO format", () => {
    const logger = new ConsoleLogger();
    logger.info("timed");
    const output = infoSpy.mock.calls[0][0] as string;
    // ISO timestamp format: YYYY-MM-DDTHH:MM:SS.sssZ
    expect(output).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("should include the prefix when provided", () => {
    const logger = new ConsoleLogger("my-pipeline");
    logger.info("step started");
    const output = infoSpy.mock.calls[0][0] as string;
    expect(output).toContain("[my-pipeline]");
  });

  it("should not include prefix brackets when no prefix is given", () => {
    const logger = new ConsoleLogger();
    logger.info("no prefix");
    const output = infoSpy.mock.calls[0][0] as string;
    expect(output).not.toContain("[");
  });

  it("should include metadata as JSON when provided", () => {
    const logger = new ConsoleLogger();
    logger.info("with meta", { stepName: "fetch", duration: 123 });
    const output = infoSpy.mock.calls[0][0] as string;
    expect(output).toContain('"stepName":"fetch"');
    expect(output).toContain('"duration":123');
  });

  it("should not include metadata section when meta is empty", () => {
    const logger = new ConsoleLogger();
    logger.info("no meta", {});
    const output = infoSpy.mock.calls[0][0] as string;
    // Should not have trailing JSON object
    expect(output).toMatch(/no meta$/);
  });

  it("should not include metadata section when meta is undefined", () => {
    const logger = new ConsoleLogger();
    logger.info("no meta");
    const output = infoSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/no meta$/);
  });
});
