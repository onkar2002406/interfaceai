/**
 * The LLM seam.
 *
 * Narrow on purpose. The agent loop needs exactly one thing from a model —
 * "given what you can see, which single tool should I call next" — and pushing
 * everything else (perception, policy, evidence, artifact compilation) outside
 * this interface is what keeps the model's influence bounded and auditable.
 *
 * It also means the entire discovery pipeline can be exercised offline against
 * a scripted provider, which matters more than it sounds: it lets the compiler,
 * the trace format and the evidence path be tested deterministically, without
 * spending tokens or depending on a model behaving the same way twice.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelTurn {
  /** The model's stated reasoning for this call. Becomes the step's `intent`. */
  reasoning: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface DecideRequest {
  system: string;
  /** Rendered observation: element inventory plus context. */
  userText: string;
  /** Optional caller cancellation signal, used by panel Stop buttons. */
  signal?: AbortSignal;
  /** PNG screenshot, if the provider and model support vision. */
  screenshot?: Buffer;
  /** Prior turns, so the model can see what it already tried. */
  history: Array<{ turn: ModelTurn; result: string }>;
  tools: ToolDefinition[];
  /**
   * What to say when the model answers in prose instead of calling a tool.
   *
   * Overridable because the seam now has two callers with different tool sets:
   * discovery, whose escape hatches are `finish` and `give_up`, and the chatbot,
   * whose escape hatch is `reply_to_user`. A nudge that names the wrong tools is
   * worse than no nudge — it tells the model to call something that does not
   * exist. Defaulted, so the common case stays a one-line request.
   */
  nudge?: string;
  /**
   * A tool to *force* on the final attempt, when nudging has not worked.
   *
   * `tool_choice: "required"` is precisely what some hosts reject with a 400
   * when the model answers in prose; naming one specific function instead
   * usually succeeds where "required" fails, because the host no longer has to
   * decide anything.
   *
   * Only safe when there is a tool that cannot fabricate a result. The chatbot
   * sets `reply_to_user`: worst case the model talks to the person instead of
   * dying. Discovery deliberately sets nothing — forcing `finish` would invent
   * an outcome the run never reached, which is far worse than failing.
   */
  forceToolOnLastAttempt?: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Whether this model accepts a screenshot alongside the text inventory.
   *
   * Declared rather than assumed, because plenty of hosts offer no vision model
   * at all, and several that do cannot combine images with tool calling. The
   * discovery loop attaches the screenshot only when this is true — and works
   * either way, because the model acts by element id from the text inventory.
   * The screenshot is corroboration, never the action space.
   */
  readonly supportsVision: boolean;
  decide(req: DecideRequest): Promise<ModelTurn>;
  /** Total tokens consumed, for the run report. */
  usage(): { promptTokens: number; completionTokens: number; calls: number };
}
