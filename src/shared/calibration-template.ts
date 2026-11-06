// RUN-001 / SETUP-001: the placeholder outputs of the kit's calibration fixture templates.
// Setup writes them into .benchrouter/calibration.<slug token>.json. Local calibrate finds a
// fixture that still holds one by its exact text, and fails it with fill-in instructions
// instead of scoring the TODO text. The signed runtime mirrors this file (runtime/MIRROR.txt).

export const CALIBRATION_TEMPLATE_PLACEHOLDERS = {
  codeConsumedGood: "TODO: assistant output the code should accept",
  codeConsumedBroken: "TODO: wrong enum/id/tool arg/consumed field that still parses",
  humanReadGood: "TODO: human-facing answer that should pass",
  humanReadBroken: "TODO: fluent but factually wrong or constraint-violating answer"
} as const;

const PLACEHOLDER_OUTPUTS: ReadonlySet<string> = new Set(Object.values(CALIBRATION_TEMPLATE_PLACEHOLDERS));

/** True when a fixture's output text is still a kit template placeholder. */
export function isCalibrationPlaceholder(outputText: string): boolean {
  return PLACEHOLDER_OUTPUTS.has(outputText);
}
