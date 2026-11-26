export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";

export const LLM_REASONING_EFFORT_OPTIONS = ["low", "medium", "high", "max"] as const;
export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORT_OPTIONS)[number];

export const LLM_API_FORMAT_OPTIONS = ["responses", "chat-completions"] as const;
export type LlmApiFormat = (typeof LLM_API_FORMAT_OPTIONS)[number];
export const LLM_REASONING_OPTIONS = ["default", "disabled", "enabled", ...LLM_REASONING_EFFORT_OPTIONS] as const;
export type LlmReasoning = (typeof LLM_REASONING_OPTIONS)[number];

export const LLM_SERVICE_TYPE_OPTIONS = ["openai-compatible", "google", "deepseek"] as const;
export type LlmServiceType = (typeof LLM_SERVICE_TYPE_OPTIONS)[number];

export const LLM_OUTPUT_FORMAT_OPTIONS = ["none", "json_object", "json_schema"] as const;
export type LlmOutputFormat = (typeof LLM_OUTPUT_FORMAT_OPTIONS)[number];

export const llmServiceChoices = (
  serviceType: LlmServiceType,
): { reasoning: readonly LlmReasoning[]; outputFormat: readonly LlmOutputFormat[] } =>
  serviceType === "deepseek"
    ? { reasoning: ["default", "disabled", "enabled", "low", "high", "max"], outputFormat: ["none", "json_object"] }
    : { reasoning: ["default", "disabled", "low", "medium", "high"], outputFormat: LLM_OUTPUT_FORMAT_OPTIONS };

export const fitLlmChoices = (serviceType: LlmServiceType, reasoning: LlmReasoning, outputFormat: LlmOutputFormat) => {
  const choices = llmServiceChoices(serviceType);
  return {
    reasoning: choices.reasoning.includes(reasoning) ? reasoning : ("default" as const),
    outputFormat: choices.outputFormat.includes(outputFormat) ? outputFormat : ("json_object" as const),
  };
};
