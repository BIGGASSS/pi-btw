// Run with Node.js 22.19+: node --test tests/usage.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type AssistantMessage,
	type Model,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	FooterComponent,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ReadonlyFooterDataProvider,
	type ResourceLoader,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createBtwUsageRecorder } from "../extensions/lib/usage.ts";

type NativeUsageEntry = Extract<SessionEntry, { type: "usage" }>;
type UsageRow = Pick<NativeUsageEntry, "kind" | "provider" | "model" | "usage">;
const fallbackModel = { provider: "fallback-provider", id: "fallback-model" };

function usage(scale = 1, subsets = true): Usage {
	return {
		input: 10 * scale,
		output: 4 * scale,
		cacheRead: 6 * scale,
		cacheWrite: 2 * scale,
		...(subsets ? { cacheWrite1h: scale, reasoning: 2 * scale } : {}),
		totalTokens: 22 * scale,
		// Binary fractions keep cumulative assertions exact, without repricing tokens.
		cost: {
			input: scale / 8,
			output: scale / 4,
			cacheRead: scale / 16,
			cacheWrite: scale / 32,
			total: (15 * scale) / 32,
		},
	};
}

function assistant(value: Usage, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "PRIVATE_SIDE_ANSWER" }],
		api: "openai-responses",
		provider: "side-provider",
		model: "side-model",
		usage: value,
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
		...overrides,
	};
}

function toolResult(value?: Usage): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "side-call",
		toolName: "side-tool",
		content: [{ type: "text", text: "PRIVATE_SIDE_TOOL_OUTPUT" }],
		...(value ? { usage: value } : {}),
		isError: false,
		timestamp: 1_700_000_000_001,
	};
}

function expectedRow(value: Usage, provider = "side-provider", model = "side-model"): UsageRow {
	return { kind: "btw", provider, model, usage: value };
}

function btwEntries(manager: SessionManager): NativeUsageEntry[] {
	return manager.getEntries().filter((entry): entry is NativeUsageEntry => entry.type === "usage" && entry.kind === "btw");
}

function rows(entries: NativeUsageEntry[]): UsageRow[] {
	return entries.map(({ kind, provider, model, usage: value }) => ({ kind, provider, model, usage: value }));
}

function seededChild(parent: SessionManager): SessionManager {
	return SessionManager.inMemory(parent.getCwd(), undefined, structuredClone(parent.getEntries()));
}

test("captures the initial child journal length and excludes every kind of seeded parent usage", () => {
	const parent = SessionManager.inMemory();
	const firstId = parent.appendMessage({ role: "user", content: "Main question", timestamp: 1 });
	parent.appendMessage(assistant(usage(10)));
	parent.appendMessage(toolResult(usage(20)));
	parent.appendCompaction("Seed summary", firstId, 100, undefined, false, usage(30));
	parent.branchWithSummary(parent.getLeafId(), "Seed branch summary", undefined, false, usage(40));
	parent.appendUsage("cache_warm", "main-provider", "main-model", usage(50));
	const child = seededChild(parent);
	const parentBefore = structuredClone(parent.getEntries());
	const flush = createBtwUsageRecorder(parent, child, () => fallbackModel);

	assert.equal(flush(), false);
	assert.deepEqual(parent.getEntries(), parentBefore);
	child.appendMessage(assistant(usage()));
	assert.equal(flush(), true);
	assert.deepEqual(parent.getEntries().slice(0, parentBefore.length), parentBefore);
	assert.deepEqual(rows(btwEntries(parent)), [expectedRow(usage())]);
	assert.equal(flush(), false);
	assert.equal(btwEntries(parent).length, 1);
});

test("flushes multiple assistant turns once, preserving exact usage and the actual response model", () => {
	const parent = SessionManager.inMemory();
	parent.appendMessage({ role: "user", content: "Main question", timestamp: 1 });
	const child = SessionManager.inMemory();
	const flush = createBtwUsageRecorder(parent, child, () => fallbackModel);
	const first = usage();
	first.totalTokens = 123_456; // Preserve provider-reported totals rather than reconstructing them.
	first.cost = { input: 0.000000123, output: 0.987654321, cacheRead: 0.000012345, cacheWrite: 0.012345678, total: 1.000012467 };
	const second = usage(2, false);
	const third = usage(3);
	child.appendMessage({ role: "user", content: "PRIVATE_SIDE_QUESTION", timestamp: 2 });
	child.appendMessage(assistant(first, { stopReason: "toolUse", responseModel: "physical-response-model" }));
	child.appendMessage(toolResult());
	child.appendMessage(assistant(second, { provider: "second-provider", model: "requested-model" }));
	const childBefore = structuredClone(child.getEntries());
	const contextBefore = structuredClone(parent.buildSessionContext());
	const previousLeaf = parent.getLeafId();

	assert.equal(flush(), true, "flush returns a boolean synchronously, not a Promise");
	assert.deepEqual(rows(btwEntries(parent)), [
		expectedRow(first, "side-provider", "physical-response-model"),
		expectedRow(second, "second-provider", "requested-model"),
	]);
	assert.deepEqual(child.getEntries(), childBefore, "recording does not mutate child usage or messages");
	assert.deepEqual(parent.buildSessionContext(), contextBefore, "side content never enters parent context");
	assert.equal(btwEntries(parent)[0].parentId, previousLeaf);
	assert.equal(btwEntries(parent)[1].parentId, btwEntries(parent)[0].id);
	const parentAfter = structuredClone(parent.getEntries());
	assert.equal(flush(), false);
	assert.deepEqual(parent.getEntries(), parentAfter);

	// The parent may keep chatting while the same child records another exchange.
	const mainId = parent.appendMessage({ role: "user", content: "Next main turn", timestamp: 3 });
	child.appendMessage({ role: "user", content: "Another side question", timestamp: 4 });
	child.appendMessage(assistant(third, { provider: "third-provider", model: "third-model" }));
	assert.equal(flush(), true);
	assert.equal(btwEntries(parent)[2].parentId, mainId);
	assert.deepEqual(rows(btwEntries(parent)), [
		expectedRow(first, "side-provider", "physical-response-model"),
		expectedRow(second, "second-provider", "requested-model"),
		expectedRow(third, "third-provider", "third-model"),
	]);
	assert.equal(new Set(parent.getEntries().map((entry) => entry.id)).size, parent.getEntries().length);
	assert.equal(flush(), false);
});

test("records tool, compaction, branch-summary and native usage from the journal, not just active context", () => {
	const parent = SessionManager.inMemory();
	const child = SessionManager.inMemory();
	let model = fallbackModel;
	const flush = createBtwUsageRecorder(parent, child, () => model);
	const assistantId = child.appendMessage(assistant(usage()));
	child.appendMessage(toolResult(usage(2)));
	child.appendCompaction("PRIVATE_COMPACTION", null, 500, undefined, false, usage(3));
	child.branchWithSummary(null, "PRIVATE_BRANCH_SUMMARY", undefined, false, usage(4));
	child.appendUsage("cache_warm", "native-provider", "native-model", usage(5));
	assert.equal(child.getBranch().some((entry) => entry.id === assistantId), false);
	assert.equal(child.buildSessionContext().messages.some((message) => message.role === "assistant"), false);

	assert.equal(flush(), true);
	assert.deepEqual(rows(btwEntries(parent)), [
		expectedRow(usage()),
		expectedRow(usage(2), model.provider, model.id),
		expectedRow(usage(3), model.provider, model.id),
		expectedRow(usage(4), model.provider, model.id),
		expectedRow(usage(5), "native-provider", "native-model"),
	]);
	assert.equal(parent.getEntries().every((entry) => entry.type === "usage" && entry.kind === "btw"), true);
	assert.deepEqual(parent.buildSessionContext().messages, []);
	assert.equal(flush(), false);

	model = { provider: "new-fallback-provider", id: "new-fallback-model" };
	child.appendMessage({ ...toolResult(usage(6)), isError: true });
	child.appendCompaction("Later summary", null, 600, undefined, true, usage(7));
	child.branchWithSummary(null, "Later branch summary", undefined, true, usage(8));
	assert.equal(flush(), true);
	assert.deepEqual(rows(btwEntries(parent)).slice(5), [
		expectedRow(usage(6), model.provider, model.id),
		expectedRow(usage(7), model.provider, model.id),
		expectedRow(usage(8), model.provider, model.id),
	]);
	assert.equal(flush(), false);
});

test("copies usage and never retries an entry already appended before a disk-write failure", () => {
	const parent = SessionManager.inMemory();
	const child = SessionManager.inMemory();
	const flush = createBtwUsageRecorder(parent, child, () => fallbackModel);
	const value = usage();
	const expected = structuredClone(value);
	const append = parent.appendUsage.bind(parent);
	parent.appendUsage = (...args) => {
		append(...args);
		throw new Error("synthetic disk-write failure");
	};
	child.appendMessage(assistant(value));
	assert.throws(flush, /synthetic disk-write failure/);
	value.cost.total = 999;
	value.input = 999;
	assert.deepEqual(rows(btwEntries(parent)), [expectedRow(expected)]);
	assert.equal(flush(), false, "the manager already appended this entry in memory");
	assert.equal(btwEntries(parent).length, 1);
});

test("usage-only sessions follow pi's deferred file creation and persist when main chat begins", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-btw-deferred-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const parent = SessionManager.create(dir, join(dir, "sessions"));
	const child = SessionManager.inMemory(dir);
	const flush = createBtwUsageRecorder(parent, child, () => fallbackModel);
	child.appendMessage(assistant(usage()));
	assert.equal(flush(), true);
	const file = parent.getSessionFile()!;
	assert.equal(existsSync(file), false, "native usage entries alone do not create a file");
	assert.deepEqual(rows(btwEntries(parent)), [expectedRow(usage())]);
	parent.appendMessage({ role: "user", content: "First main question", timestamp: 1 });
	assert.equal(existsSync(file), true);
	assert.deepEqual(rows(btwEntries(SessionManager.open(file))), [expectedRow(usage())]);
	assert.equal(flush(), false);
});

test("records native child usage of any kind using its own provider and model", () => {
	const parent = SessionManager.inMemory();
	const child = SessionManager.inMemory();
	const flush = createBtwUsageRecorder(parent, child, () => fallbackModel);
	for (const kind of ["cache_warm", "btw", "extension-specific-operation"]) {
		child.appendUsage(kind, "native-provider", kind, usage());
	}
	assert.equal(flush(), true);
	assert.deepEqual(rows(btwEntries(parent)), [
		expectedRow(usage(), "native-provider", "cache_warm"),
		expectedRow(usage(), "native-provider", "btw"),
		expectedRow(usage(), "native-provider", "extension-specific-operation"),
	]);
	assert.equal(flush(), false);
});

test("skips usage-free entries and advances past them without adding parent context or metadata", () => {
	const parent = SessionManager.inMemory();
	const child = SessionManager.inMemory();
	const flush = createBtwUsageRecorder(parent, child, () => fallbackModel);
	assert.equal(flush(), false);
	child.appendMessage({ role: "user", content: "Unanswered side question", timestamp: 1 });
	child.appendMessage({ role: "system", content: "Side system prompt", timestamp: 2 });
	child.appendMessage(toolResult());
	child.appendModelChange("unused-provider", "unused-model");
	child.appendThinkingLevelChange("high");
	child.appendCustomEntry("ignored", { usage: usage(100) });
	child.appendCustomMessageEntry("ignored-message", "Side custom content", false, { usage: usage(100) });
	child.appendCompaction("Usage-free compaction", null, 100);
	child.branchWithSummary(null, "Usage-free branch summary");
	// Older/custom journals can lack usage even though the current assistant type requires it.
	const { usage: _omitted, ...withoutUsage } = assistant(usage());
	child.appendMessage(withoutUsage as AssistantMessage);

	assert.equal(flush(), false);
	assert.equal(flush(), false);
	assert.deepEqual(parent.getEntries(), []);
	child.appendMessage(assistant(usage()));
	assert.equal(flush(), true);
	assert.deepEqual(rows(btwEntries(parent)), [expectedRow(usage())]);
	assert.equal(flush(), false);
});

for (const stopReason of ["error", "aborted"] as const) {
	test(`counts billed usage from ${stopReason} assistant responses`, () => {
		const parent = SessionManager.inMemory();
		const child = SessionManager.inMemory();
		const flush = createBtwUsageRecorder(parent, child, () => fallbackModel);
		child.appendMessage(assistant(usage(), { stopReason, errorMessage: "Partial side response" }));
		assert.equal(flush(), true);
		assert.deepEqual(rows(btwEntries(parent)), [expectedRow(usage())]);
		assert.equal(flush(), false);
	});
}

test("records zero-price tokens and all-zero usage, retaining optional zero-valued subsets", () => {
	const parent = SessionManager.inMemory();
	const child = SessionManager.inMemory();
	const flush = createBtwUsageRecorder(parent, child, () => fallbackModel);
	const free = { ...usage(), cost: usage(0).cost };
	const zero = usage(0);
	child.appendMessage(assistant(free));
	child.appendMessage(assistant(zero));
	child.appendUsage("free-operation", "free-provider", "free-model", usage(0, false));
	assert.equal(flush(), true);
	assert.deepEqual(rows(btwEntries(parent)), [
		expectedRow(free),
		expectedRow(zero),
		expectedRow(usage(0, false), "free-provider", "free-model"),
	]);
	assert.equal(flush(), false);
});

for (const appendUsage of [undefined, null, "not a function"]) {
	test(`rejects an unsupported parent appendUsage (${String(appendUsage)}) at factory creation`, () => {
		const parent = SessionManager.inMemory();
		Object.defineProperty(parent, "appendUsage", { value: appendUsage });
		assert.throws(
			() => createBtwUsageRecorder(parent, SessionManager.inMemory(), () => fallbackModel),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /pi.*1\.4\.0/i);
				assert.match(error.message, /requires?|required|upgrade|update/i);
				return true;
			},
		);
		assert.deepEqual(parent.getEntries(), []);
	});
}

for (const alreadyFlushed of [false, true]) {
	test(`refuses a changed parent session id ${alreadyFlushed ? "after" : "before"} the first successful flush`, () => {
		const parent = SessionManager.inMemory();
		const child = SessionManager.inMemory();
		const flush = createBtwUsageRecorder(parent, child, () => fallbackModel);
		if (alreadyFlushed) {
			child.appendMessage(assistant(usage()));
			assert.equal(flush(), true);
		}
		const capturedId = parent.getSessionId();
		parent.newSession();
		assert.notEqual(parent.getSessionId(), capturedId);
		const newParentBefore = structuredClone(parent.getEntries());
		// Check even a no-op flush: stale recorders must never silently follow /new.
		assert.throws(flush, /parent|session/i);
		child.appendMessage(assistant(usage(2)));
		assert.throws(flush, /parent|session/i);
		assert.deepEqual(parent.getEntries(), newParentBefore, "nothing is attributed to the replacement session");
	});
}

// No resource discovery, credential files, model refreshes, or model requests.
async function offlineSession(manager: SessionManager) {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => "Offline usage test",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	const model: Model<"openai-responses"> = {
		provider: "usage-test-provider",
		id: "parent-model",
		name: "Offline parent model",
		api: "openai-responses",
		baseUrl: "http://127.0.0.1:1",
		input: ["text"],
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const { session } = await createAgentSession({
		cwd: manager.getCwd(),
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" }),
		modelRuntime,
		resourceLoader,
		model,
		thinkingLevel: "off",
		tools: [],
	});
	return session;
}

const footerData: ReadonlyFooterDataProvider = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 1,
	onBranchChange: () => () => {},
};

for (const storage of ["in-memory", "persistent"] as const) {
	test(`native session stats and default footer include btw usage (${storage})`, async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-btw-usage-test-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const parent = storage === "persistent" ? SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory(dir);
		// Native persistence intentionally waits for a main user/assistant message.
		parent.appendMessage({ role: "user", content: "Main question", timestamp: 1 });
		parent.appendMessage(assistant(usage(), { content: [{ type: "text", text: "Main answer" }] }));
		parent.appendUsage("cache_warm", "main-provider", "main-model", usage(2));
		const session = await offlineSession(parent);
		t.after(() => session.dispose());
		initTheme("system", false);
		const footer = new FooterComponent(session, footerData);
		t.after(() => footer.dispose());
		const footerLine = () => stripVTControlCharacters(footer.render(200)[1]);
		assert.match(footerLine(), /^↑30 ↓12 R18 W6\b/);
		assert.ok(footerLine().includes("$1.406"));

		const child = seededChild(parent);
		const flush = createBtwUsageRecorder(parent, child, () => fallbackModel);
		const contextBefore = structuredClone(parent.buildSessionContext());
		const contextUsageBefore = session.getContextUsage();
		assert.equal(flush(), false);
		child.appendMessage(assistant(usage(3), { responseModel: "actual-side-model" }));
		child.appendMessage(toolResult(usage(4)));
		child.appendUsage("cache_warm", "native-provider", "native-model", usage(5));
		assert.equal(flush(), true);
		assert.match(footerLine(), /^↑150 ↓60 R90 W30\b/, "existing footer refreshes its cached totals");
		assert.ok(footerLine().includes("$7.031"));

		child.appendCompaction("PRIVATE_SIDE_COMPACTION", null, 1000, undefined, false, usage(6));
		child.branchWithSummary(null, "PRIVATE_SIDE_BRANCH_SUMMARY", undefined, false, usage(7));
		assert.equal(flush(), true);
		assert.equal(flush(), false);
		const expected = [
			expectedRow(usage(3), "side-provider", "actual-side-model"),
			expectedRow(usage(4), fallbackModel.provider, fallbackModel.id),
			expectedRow(usage(5), "native-provider", "native-model"),
			expectedRow(usage(6), fallbackModel.provider, fallbackModel.id),
			expectedRow(usage(7), fallbackModel.provider, fallbackModel.id),
		];
		assert.deepEqual(rows(btwEntries(parent)), expected);
		const stats = session.getSessionStats();
		assert.deepEqual(stats.tokens, { input: 280, output: 112, cacheRead: 168, cacheWrite: 56, total: 616 });
		assert.equal(stats.cost, 13.125);
		assert.equal(stats.userMessages, 1);
		assert.equal(stats.assistantMessages, 1);
		assert.equal(stats.toolCalls, 0);
		assert.equal(stats.toolResults, 0);
		assert.equal(stats.totalMessages, 2);
		assert.deepEqual(stats.contextUsage, contextUsageBefore);
		assert.deepEqual(parent.buildSessionContext(), contextBefore);
		assert.match(footerLine(), /^↑280 ↓112 R168 W56\b/);
		assert.ok(footerLine().includes("$13.125"));

		if (storage === "persistent") {
			const file = parent.getSessionFile();
			assert.ok(file);
			const persisted = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(persisted[0].type, "session");
			assert.equal(persisted[0].id, parent.getSessionId());
			assert.deepEqual(persisted.slice(1), JSON.parse(JSON.stringify(parent.getEntries())));
			assert.equal(readFileSync(file, "utf8").includes("PRIVATE_SIDE_"), false);
			const reopened = SessionManager.open(file);
			assert.deepEqual(rows(btwEntries(reopened)), expected, "all exact usage fields survive JSONL reload");
			assert.deepEqual(reopened.buildSessionContext(), contextBefore);
			const restoredSession = await offlineSession(reopened);
			t.after(() => restoredSession.dispose());
			assert.deepEqual(restoredSession.getSessionStats(), stats);
			const restoredFooter = new FooterComponent(restoredSession, footerData);
			t.after(() => restoredFooter.dispose());
			assert.equal(stripVTControlCharacters(restoredFooter.render(200)[1]), footerLine());
		}
	});
}
