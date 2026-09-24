import type { AgentPlan } from "../semantic/intent";
import type { ResultSet } from "../semantic/execute";
import type { ChartType } from "../semantic/chart";
import type { DeskContext, FindingBrief, PromptContext } from "./prompts";
import type { DeskPlan } from "../desk/actions";
import type { Narration } from "./schema";

/**
 * The two - and only two - places a language model is allowed to act.
 *
 * Note what is absent: no "run this query", no "compute this number", no
 * "format this result". Everything between `plan` and `narrate` is code.
 */
export interface LLMProvider {
  readonly name: string;
  /** Question -> typed intent, or a documented refusal. */
  plan(question: string, ctx: PromptContext): Promise<AgentPlan>;
  /** Computed numbers -> prose. Never sees the database. */
  narrate(question: string, result: ResultSet, allowedChartTypes: ChartType[]): Promise<Narration>;
  /** A detected finding -> a sentence a person can act on. */
  narrateFinding(finding: FindingBrief): Promise<string>;
  /** A request -> a proposed write, or a documented refusal. Never applied here. */
  propose(request: string, ctx: DeskContext): Promise<DeskPlan>;
  /** An assembled digest -> its opening paragraph. */
  summariseDigest(brief: string): Promise<string>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = "LLMError";
  }
}
