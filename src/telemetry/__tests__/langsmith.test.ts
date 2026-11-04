/**
 * The Langfuse -> LangSmith attribute translation.
 *
 * This is the whole reason the LangSmith export is not three lines of config.
 * Langfuse writes `langfuse.observation.*`; LangSmith reads `gen_ai.*`,
 * `langsmith.*` and the OpenInference `input.value`/`output.value` pair. Get
 * the mapping wrong and traces still arrive, still nest correctly, and are
 * still completely empty - which is exactly the failure that does not announce
 * itself. Hence tests.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { toLangSmithAttributes, createLangSmithProcessor } from "../langsmith";
import { initTelemetry, resetTelemetryForTesting, telemetryDestinations } from "../index";

describe("toLangSmithAttributes", () => {
  it("maps a generation to an llm run with model and tokens", () => {
    const out = toLangSmithAttributes({
      "langfuse.observation.type": "generation",
      "langfuse.observation.model.name": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "langfuse.observation.usage_details": JSON.stringify({ input: 1900, output: 125, total: 2025 }),
    });

    expect(out["langsmith.span.kind"]).toBe("llm");
    expect(out["gen_ai.request.model"]).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(out["gen_ai.response.model"]).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(out["gen_ai.usage.input_tokens"]).toBe(1900);
    expect(out["gen_ai.usage.output_tokens"]).toBe(125);
    expect(out["gen_ai.usage.total_tokens"]).toBe(2025);
  });

  it("derives the token total when only the parts are reported", () => {
    const out = toLangSmithAttributes({
      "langfuse.observation.usage_details": JSON.stringify({ input: 10, output: 4 }),
    });
    expect(out["gen_ai.usage.total_tokens"]).toBe(14);
  });

  it("maps observation types onto LangSmith run types", () => {
    const kind = (type: string) =>
      toLangSmithAttributes({ "langfuse.observation.type": type })["langsmith.span.kind"];

    expect(kind("generation")).toBe("llm");
    expect(kind("tool")).toBe("tool");
    expect(kind("span")).toBe("chain");
    // An unrecognised type must still be a valid LangSmith run type, not undefined.
    expect(kind("something-new")).toBe("chain");
  });

  it("carries input and output across as OpenInference values", () => {
    const out = toLangSmithAttributes({
      "langfuse.observation.input": '{"question":"leads last week"}',
      "langfuse.observation.output": '{"kind":"query"}',
    });
    expect(out["input.value"]).toBe('{"question":"leads last week"}');
    expect(out["output.value"]).toBe('{"kind":"query"}');
  });

  it("falls back to trace-level input and output", () => {
    const out = toLangSmithAttributes({ "langfuse.trace.input": "how many leads?" });
    expect(out["input.value"]).toBe("how many leads?");
  });

  it("prefers observation input over trace input", () => {
    const out = toLangSmithAttributes({
      "langfuse.observation.input": "observation",
      "langfuse.trace.input": "trace",
    });
    expect(out["input.value"]).toBe("observation");
  });

  it("joins tags into the comma-separated string LangSmith expects", () => {
    const out = toLangSmithAttributes({
      "langfuse.trace.tags": JSON.stringify(["eval", "intent-accuracy"]),
    });
    expect(out["langsmith.span.tags"]).toBe("eval,intent-accuracy");
  });

  it("flattens metadata under langsmith.metadata.*", () => {
    const out = toLangSmithAttributes({
      "langfuse.observation.metadata": JSON.stringify({ caseId: "leads-last-week", retries: 2 }),
      "langfuse.observation.metadata.grain": "total",
    });
    expect(out["langsmith.metadata.caseId"]).toBe("leads-last-week");
    expect(out["langsmith.metadata.retries"]).toBe(2);
    expect(out["langsmith.metadata.grain"]).toBe("total");
  });

  it("leaves the Langfuse attributes in place", () => {
    const out = toLangSmithAttributes({ "langfuse.observation.type": "generation" });
    expect(out["langfuse.observation.type"]).toBe("generation");
  });

  it("survives malformed JSON rather than throwing", () => {
    const out = toLangSmithAttributes({
      "langfuse.observation.usage_details": "{not json",
      "langfuse.observation.metadata": "{also not json",
    });
    expect(out["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(out["langsmith.metadata.caseId"]).toBeUndefined();
  });

  it("adds nothing when there is nothing to map", () => {
    const out = toLangSmithAttributes({ "http.method": "POST" });
    expect(out).toEqual({ "http.method": "POST" });
  });
});

describe("createLangSmithProcessor", () => {
  it("returns null when no API key is provided", () => {
    const res = createLangSmithProcessor({});
    expect(res).toBeNull();
  });

  it("creates processor with default endpoint and project", () => {
    const res = createLangSmithProcessor({ LANGSMITH_API_KEY: "lsv2_pt_test" });
    expect(res).not.toBeNull();
    expect(res?.endpoint).toBe("https://api.smith.langchain.com/otel/v1/traces");
    expect(res?.project).toBe("leadpulse");
  });

  it("handles custom endpoint with trailing slashes and custom project", () => {
    const res = createLangSmithProcessor({
      LANGSMITH_API_KEY: "lsv2_pt_test",
      LANGSMITH_ENDPOINT: "https://eu.api.smith.langchain.com/otel///",
      LANGSMITH_PROJECT: "leadpulse-prod",
    });
    expect(res).not.toBeNull();
    expect(res?.endpoint).toBe("https://eu.api.smith.langchain.com/otel/v1/traces");
    expect(res?.project).toBe("leadpulse-prod");
  });
});

describe("telemetry initialization with LangSmith", () => {
  beforeEach(() => {
    resetTelemetryForTesting();
  });

  it("initializes standalone LangSmith when Langfuse is not configured", () => {
    const ok = initTelemetry({
      LANGSMITH_API_KEY: "lsv2_pt_test",
      LANGSMITH_PROJECT: "test-proj",
    });
    expect(ok).toBe(true);
    const dest = telemetryDestinations();
    expect(dest.langfuse).toBe(false);
    expect(dest.langsmith).toBe("https://api.smith.langchain.com/otel/v1/traces (test-proj)");
  });

  it("initializes dual-export when both are configured", () => {
    const ok = initTelemetry({
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGSMITH_API_KEY: "lsv2_pt_test",
      LANGSMITH_PROJECT: "test-dual",
    });
    expect(ok).toBe(true);
    const dest = telemetryDestinations();
    expect(dest.langfuse).toBe(true);
    expect(dest.langsmith).toBe("https://api.smith.langchain.com/otel/v1/traces (test-dual)");
  });

  it("returns false when neither is configured", () => {
    const ok = initTelemetry({});
    expect(ok).toBe(false);
    const dest = telemetryDestinations();
    expect(dest.langfuse).toBe(false);
    expect(dest.langsmith).toBeNull();
  });
});
