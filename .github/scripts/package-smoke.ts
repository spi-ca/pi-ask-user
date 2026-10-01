import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

type PackageManifest = {
  name: string;
  main?: string;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type AssertionProfile = {
  extension: boolean;
  tools?: readonly string[];
  providers?: readonly string[];
  commands?: readonly string[];
  hooks?: readonly string[];
  eventListeners?: readonly string[];
  exports?: readonly string[];
};

const PROFILES: Record<string, AssertionProfile> = {
  "pi-ask-user": { extension: true, tools: ["ask_user"], hooks: ["session_start", "session_shutdown"] },
  "pi-cmux-presence": {
    extension: true,
    hooks: ["agent_settled", "session_start", "agent_start", "turn_start", "ui_prompt_start", "ui_prompt_end", "message_end", "agent_end", "before_agent_start", "tool_execution_start", "tool_execution_end", "tool_result", "session_info_changed", "session_shutdown"],
    eventListeners: ["pi-presence:state:v2", "pi-presence:terminal:v2", "pi-presence:withdraw:v2", "pi-presence:consumer-ready:v2"],
  },
  // A Herdr identity is deliberately not fabricated: its default no-session
  // registration must remain inert when the clean smoke environment has none.
  "pi-herdr-presence": { extension: true },
  "pi-kiro-api": { extension: true, providers: ["kiro-api-key"] },
  "@mjakl/pi-subagent": { extension: true, tools: ["subagent"], commands: ["subagents"], hooks: ["session_start", "agent_start", "agent_settled", "session_shutdown", "before_agent_start"] },
  "@pi/presence": { extension: false, exports: ["EVENT_NAMES", "createPresenceProducer", "createPresenceConsumer"] },
};

function profileFor(name: string): AssertionProfile {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`no smoke assertion profile for ${name}`);
  return profile;
}

function sandboxEnv(root: string): Record<string, string> {
  const home = join(root, "home");
  const cache = join(root, "bun-cache");
  mkdirSync(home, { recursive: true });
  mkdirSync(cache, { recursive: true });
  // This is an allowlist, not a redacted copy of the CI/session environment.
  return { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir(), CI: "1", PI_OFFLINE: "1", BUN_INSTALL_CACHE_DIR: cache };
}

function run(command: string[], cwd: string, env: Record<string, string>): void {
  const result = Bun.spawnSync({ cmd: command, cwd, env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
}

function smokeStub(packageSpecifier: string, profile: AssertionProfile, checkerSpecifier = "typebox/value"): string {
  return `
const profile = ${JSON.stringify(profile)};
const calls = [];
const unsubscriptions = [];
const listener = (kind, name, value) => {
  calls.push({ kind, name: String(name), value });
  let active = true;
  const unsubscribe = () => { if (active) { active = false; calls.push({ kind: "unsubscribe", name: String(name) }); } };
  unsubscriptions.push(unsubscribe);
  return unsubscribe;
};
const pi = {
  events: {
    on: (name, callback) => listener("events.on", name, callback),
    emit: (name, payload) => calls.push({ kind: "events.emit", name: String(name), value: payload }),
  },
  on: (name, callback) => listener("on", name, callback),
  registerTool: (value) => calls.push({ kind: "registerTool", name: String(value?.name), value }),
  registerProvider: (value) => calls.push({ kind: "registerProvider", name: String(value?.id ?? value?.api), value }),
  registerCommand: (name, value) => calls.push({ kind: "registerCommand", name: String(name), value }),
  registerFlag: (name, value) => calls.push({ kind: "registerFlag", name: String(name), value }),
  getFlag: () => undefined,
  getAllTools: () => [],
  getCommands: () => [],
};
const extension = await import(${JSON.stringify(packageSpecifier)});
const requireNames = (kind, names) => {
  for (const name of names ?? []) {
    if (!calls.some((call) => call.kind === kind && call.name === name)) throw new Error("missing " + kind + " registration: " + name);
  }
};
if (profile.extension) {
  if (typeof extension.default !== "function") throw new Error("callable default export is required");
  await extension.default(pi);
  requireNames("registerTool", profile.tools);
  requireNames("registerProvider", profile.providers);
  requireNames("registerCommand", profile.commands);
  requireNames("on", profile.hooks);
  requireNames("events.on", profile.eventListeners);
  const askUser = calls.find((call) => call.kind === "registerTool" && call.name === "ask_user")?.value;
  if (askUser) {
    if (askUser.exposure !== "model-only" || !askUser.outputSchema) throw new Error("missing ask_user exposure/output schema");
    const result = await askUser.execute("smoke-unavailable", {}, undefined, undefined, { mode: "headless" });
    const { Check } = await import(${JSON.stringify(checkerSpecifier)});
    if (!Check(askUser.outputSchema, result.structuredContent)) throw new Error("invalid structured output");
    if ("questions" in result.structuredContent || "isError" in result) throw new Error("ask_user output semantics changed");
    if (result.structuredContent.cancelReason !== "unavailable" || result.content[0]?.text !== "Error: UI not available (running in non-interactive mode)") throw new Error("ask_user unavailable contract changed");
  }
} else {
  for (const name of profile.exports ?? []) if (!(name in extension)) throw new Error("missing required named export: " + name);
}
for (const unsubscribe of unsubscriptions) unsubscribe();
console.log(JSON.stringify({ registrations: calls.filter((call) => call.kind !== "unsubscribe").map(({ kind, name }) => ({ kind, name })), unsubscribed: unsubscriptions.length }));
`;
}

function smokeUi(packageName: string): string {
  return `
const ui = await import(${JSON.stringify(`${packageName}/ui`)});
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(typeof ui.createQuestionnaireComponent === "function", "missing UI component export");
assert(typeof ui.normalizeQuestions === "function", "missing UI normalizer export");
assert(ui.default === undefined, "UI entry must not be an extension registration entry");
const questions = ui.normalizeQuestions({ questions: [{
  id: "choice", prompt: "Pick one", requireReview: true, allowOther: false,
  options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
}] });
assert(Array.isArray(questions), "normalization failed");
const done = [];
let attempts = 0;
const component = ui.createQuestionnaireComponent({
  questions,
  tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } },
  theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
  canSubmit: (result) => {
    attempts++;
    assert(result.answers[0]?.value === "yes", "guard saw incorrect answer");
    result.questions[0].options[0].value = "modified";
    result.answers[0].value = "modified";
    return attempts > 1;
  },
  done: (result) => done.push(result),
});
assert(component.render(80).some(line => line.includes("Pick one")), "UI prompt did not render");
component.handleInput("1");
component.handleInput("\\r");
assert(attempts === 1 && done.length === 0, "guard veto did not preserve UI");
component.handleInput("\\r");
assert(attempts === 2 && done.length === 1, "guard retry failed");
assert(done[0].answers[0].value === "yes" && done[0].questions[0].options[0].value === "yes", "guard mutated final result");
component.cancel();
assert(done.length === 1, "UI settled twice");
console.log("installed UI import and direct guard retry passed (without extension registration)");
`;
}

function exactVersion(name: string, version: string | undefined): string {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${name} needs an exact, locally determined smoke version`);
  }
  return version;
}

function matrixPiDependencies(pkg: PackageManifest, expected: Record<string, string>): Record<string, string> {
  const peers = Object.keys(pkg.peerDependencies ?? {}).filter((name) => name.startsWith("@earendil-works/pi-"));
  for (const name of peers) exactVersion(name, expected[name]);
  return Object.fromEntries(Object.entries(expected).map(([name, version]) => [name, exactVersion(name, version)]));
}

function nonPiRuntimePeers(pkg: PackageManifest): Record<string, string> {
  return Object.fromEntries(Object.keys(pkg.peerDependencies ?? {})
    .filter((name) => !name.startsWith("@earendil-works/pi-"))
    .map((name) => [name, exactVersion(name, pkg.devDependencies?.[name])]));
}

async function assertExisting(pkg: PackageManifest, profile: AssertionProfile, expected: Record<string, string>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-package-existing-"));
  try {
    if (profile.extension) {
      // The graph verifier is imported only when needed and has no CLI effects.
      const { verifyPiGraph } = await import("./verify-pi-graph.ts");
      verifyPiGraph(join(process.cwd(), "node_modules"), expected, Object.keys(expected));
    }
    const entry = pkg.main;
    if (typeof entry !== "string" || (!entry.startsWith("./") && !entry.endsWith(".ts"))) throw new Error("package.json is missing a local main entry");
    const stub = join(root, "existing-smoke.ts");
    const checker = pkg.name === "pi-ask-user"
      ? pathToFileURL(Bun.resolveSync("typebox/value", process.cwd())).href
      : undefined;
    writeFileSync(stub, smokeStub(pathToFileURL(resolve(process.cwd(), entry)).href, profile, checker));
    run([process.execPath, "--no-install", stub], process.cwd(), sandboxEnv(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runFixture(root: string, name: string, source: string, profile: AssertionProfile, shouldPass: boolean, checkerSpecifier?: string): void {
  const packageDirectory = join(root, "node_modules", name);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), `${JSON.stringify({ name, type: "module", main: "./index.ts" })}\n`);
  writeFileSync(join(packageDirectory, "index.ts"), source);
  writeFileSync(join(root, "fixture-smoke.ts"), smokeStub(name, profile, checkerSpecifier));
  const result = Bun.spawnSync({ cmd: [process.execPath, "--no-install", "fixture-smoke.ts"], cwd: root, env: sandboxEnv(root), stdout: "pipe", stderr: "pipe" });
  if ((result.exitCode === 0) !== shouldPass) {
    throw new Error(`fixture ${name} ${shouldPass ? "did not pass" : "did not fail"}: ${result.stderr.toString()}`);
  }
}

function selfTest(): void {
  const root = mkdtempSync(join(tmpdir(), "pi-package-smoke-self-test-"));
  try {
    const extensionProfile: AssertionProfile = { extension: true, tools: ["fixture-tool"], hooks: ["session_start"], eventListeners: ["fixture:v2"] };
    runFixture(root, "valid-extension", 'export default function(pi) { pi.registerTool({ name: "fixture-tool" }); pi.on("session_start", () => {}); pi.events.on("fixture:v2", () => {}); }\n', extensionProfile, true);
    runFixture(root, "missing-default", 'export const value = true;\n', extensionProfile, false);
    runFixture(root, "zero-registrations", 'export default function() {}\n', extensionProfile, false);
    const libraryProfile: AssertionProfile = { extension: false, exports: ["EVENT_NAMES", "createPresenceProducer"] };
    runFixture(root, "valid-library", 'export const EVENT_NAMES = {}; export const createPresenceProducer = () => undefined;\n', libraryProfile, true);
    runFixture(root, "missing-library-export", 'export const EVENT_NAMES = {};\n', libraryProfile, false);
    const checker = pathToFileURL(Bun.resolveSync("typebox/value", process.cwd())).href;
    const schema = pathToFileURL(resolve("src/result.ts")).href;
    const askFixture = `import { QuestionnaireOutput } from ${JSON.stringify(schema)};
export default function(pi) { pi.registerTool({ name: "ask_user", exposure: "model-only", outputSchema: QuestionnaireOutput,
execute: async () => ({ content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
structuredContent: { answers: [], cancelled: true, cancelReason: "unavailable" } }) }); }`;
    const askProfile: AssertionProfile = { extension: true, tools: ["ask_user"] };
    runFixture(root, "valid-ask", askFixture, askProfile, true, checker);
    runFixture(root, "invalid-ask", askFixture.replace("answers: []", "answers: [null]"), askProfile, false, checker);
    console.log("generated assertion stub accepted valid fixtures and rejected malformed fixtures without auto-install");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "--self-test") return selfTest();
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
  if (typeof pkg.name !== "string" || pkg.name.length === 0) throw new Error("package.json is missing name");
  const profile = profileFor(pkg.name);
  const expected = JSON.parse(process.env.PI_GRAPH_EXPECTED ?? "{}") as Record<string, string>;
  if (process.argv[2] === "--existing") return assertExisting(pkg, profile, expected);
  const matrixPi = profile.extension ? matrixPiDependencies(pkg, expected) : {};
  const nonPiPeers = nonPiRuntimePeers(pkg);
  const root = mkdtempSync(join(tmpdir(), "pi-package-smoke-"));
  try {
    const packDirectory = join(root, "pack");
    const consumer = join(root, "consumer");
    mkdirSync(packDirectory);
    mkdirSync(consumer);
    const env = sandboxEnv(root);
    run([process.execPath, "pm", "pack", "--quiet", "--destination", packDirectory], process.cwd(), env);
    const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.join(", ") || "none"}`);
    writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ name: "package-smoke-consumer", private: true, type: "module", dependencies: { [pkg.name]: `file:${resolve(packDirectory, tarballs[0])}`, ...matrixPi, ...nonPiPeers }, overrides: matrixPi }, null, 2)}\n`);
    run([process.execPath, "install", "--ignore-scripts"], consumer, env);
    if (profile.extension) {
      const { verifyPiGraph } = await import("./verify-pi-graph.ts");
      verifyPiGraph(join(consumer, "node_modules"), matrixPi, Object.keys(matrixPi));
    }
    writeFileSync(join(consumer, "smoke.ts"), smokeStub(pkg.name, profile));
    run([process.execPath, "--no-install", "smoke.ts"], consumer, env);
    if (pkg.name === "pi-ask-user") {
      writeFileSync(join(consumer, "ui-smoke.ts"), smokeUi(pkg.name));
      run([process.execPath, "--no-install", "ui-smoke.ts"], consumer, env);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
