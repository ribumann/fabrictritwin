import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("../src/ui/public/app.js", import.meta.url), "utf8");
const tree = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function topLevelFunction(name: string): string {
  const declaration = tree.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration) {
    throw new Error(`Missing top-level UI helper: ${name}`);
  }
  return declaration.getText(tree);
}

function submissionSource(): string {
  for (const node of tree.statements) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(tree) === "elements.assistantForm.addEventListener") {
      return node.expression.arguments[1].getText(tree);
    }
  }
  throw new Error("Assistant submit listener not found");
}

it.each([200, 401])("renders the actual assistant submit handler for HTTP %s", async (status) => {
  const recovery = { hidden: true };
  const elements = {
    assistantQuestionInput: { value: "Keep my question" },
    assistantStatus: { textContent: "" },
    assistantNote: { textContent: "", after: vi.fn() },
  };
  const state = {
    athleteId: "athlete", assistantPanelAvailable: true,
    assistantTranscript: [] as { answer: string; isError: boolean }[],
  };
  const context: {
    elements: typeof elements;
    state: typeof state;
    document: { getElementById: () => typeof recovery };
    window: object;
    postJson: ReturnType<typeof vi.fn>;
    setAssistantBusy: ReturnType<typeof vi.fn>;
    renderAssistantTranscript: ReturnType<typeof vi.fn>;
    submitHandler?: (event: { preventDefault: () => void }) => Promise<void>;
  } = {
    elements, state, document: { getElementById: () => recovery },
    window: {
      TriatwinAssistantSession: {
        postQuestion: async () => ({
          response: new Response(null, { status }),
          parsedBody: status === 200
            ? { answer: "Native grounded answer", groundedOn: ["Fabric"] }
            : { error: { code: "assistant_authentication_required", message: "Sign in again." } },
        }),
      },
    },
    postJson: vi.fn(), setAssistantBusy: vi.fn(), renderAssistantTranscript: vi.fn(),
  };
  runInNewContext([
    topLevelFunction("describeAssistantFailure"),
    topLevelFunction("renderAssistantSignIn"),
    `var submitHandler = ${submissionSource()};`,
  ].join("\n"), context);
  if (!context.submitHandler) {
    throw new Error("Submit handler not loaded");
  }
  await context.submitHandler({ preventDefault: vi.fn() });
  expect(elements.assistantStatus.textContent).toBe(status === 200 ? "Answered" : "Sign-in required");
  expect(state.assistantTranscript[0].answer).toBe(status === 200 ? "Native grounded answer" : "Sign in again.");
  expect(recovery.hidden).toBe(status !== 401);
  expect(elements.assistantQuestionInput.value).toBe(status === 200 ? "" : "Keep my question");
  expect(context.setAssistantBusy).toHaveBeenLastCalledWith(false);
});
