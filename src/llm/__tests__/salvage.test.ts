/**
 * Recovering JSON that arrived with prose around it.
 *
 * The fallback model answers a `json_schema` request with a fenced block or a
 * sentence of apology in front of the object often enough that rejecting those
 * outright costs about one written summary in four. What is being recovered is
 * well-formed JSON that was never malformed - only badly wrapped.
 */
import { describe, expect, it } from "vitest";
import { __test_firstJsonObject as firstJsonObject } from "../workersai";

describe("firstJsonObject", () => {
  it("reads a bare object unchanged", () => {
    expect(firstJsonObject('{"headline":"a","narrative":"b"}')).toEqual({ headline: "a", narrative: "b" });
  });

  it("recovers an object from a fenced block", () => {
    const text = 'Here you go:\n```json\n{"headline":"181 leads","narrative":"Up 7%."}\n```';
    expect(firstJsonObject(text)).toEqual({ headline: "181 leads", narrative: "Up 7%." });
  });

  it("recovers an object with a sentence in front of it", () => {
    expect(firstJsonObject('Sure! {"note":"fine"} Let me know if you need more.')).toEqual({ note: "fine" });
  });

  it("keeps nested objects whole", () => {
    const text = 'result: {"a":{"b":{"c":1}},"d":2} done';
    expect(firstJsonObject(text)).toEqual({ a: { b: { c: 1 } }, d: 2 });
  });

  it("is not fooled by a brace inside a string", () => {
    // The naive lastIndexOf("}") version of this truncates at the wrong brace.
    expect(firstJsonObject('{"narrative":"a } inside","headline":"x"}')).toEqual({
      narrative: "a } inside",
      headline: "x",
    });
  });

  it("is not fooled by an escaped quote", () => {
    expect(firstJsonObject('{"narrative":"he said \\"up 7%\\" yesterday"}')).toEqual({
      narrative: 'he said "up 7%" yesterday',
    });
  });

  it("returns null rather than guessing when there is no object", () => {
    expect(firstJsonObject("I cannot help with that.")).toBeNull();
    expect(firstJsonObject("")).toBeNull();
  });

  it("closes a string the model forgot to close", () => {
    // The live failure: a complete sentence, a closing brace, and no closing
    // quote between them. Lost one written summary in three until it was
    // recovered here.
    const text = '{"headline":"616 leads","narrative":"Volume rose 13% this month.}';
    expect(firstJsonObject(text)).toEqual({ headline: "616 leads", narrative: "Volume rose 13% this month." });
  });

  it("closes one even with no brace at the end at all", () => {
    expect(firstJsonObject('{"note":"Conversion held at 40.9%.')).toEqual({ note: "Conversion held at 40.9%." });
  });

  it("refuses to close a response that was cut off mid-thought", () => {
    // Half a sentence presented as a finished read-out is worse than none.
    expect(firstJsonObject('{"narrative":"Volume rose 13% and cost per lea')).toBeNull();
    expect(firstJsonObject('{"headline":"truncated mid')).toBeNull();
  });

  it("returns null rather than repairing genuinely broken JSON", () => {
    // Salvaging the wrapper is fine; inventing the content is not.
    expect(firstJsonObject("{headline: unquoted}")).toBeNull();
  });
});
