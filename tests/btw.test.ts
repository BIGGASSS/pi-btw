// Node.js 22.19+: node --experimental-test-module-mocks --test tests/btw.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test, type TestContext } from "node:test";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import * as sdk from "@earendil-works/pi-coding-agent";

const model: Model<"openai-responses"> = {
	id: "offline-model", provider: "offline-provider", name: "Offline test model",
	api: "openai-responses", baseUrl: "http://127.0.0.1:1", input: ["text"],
	reasoning: false, contextWindow: 200_000, maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function usage(scale = 1): Usage {
	return {
		input: 10 * scale, output: 4 * scale, cacheRead: 6 * scale, cacheWrite: 2 * scale,
		cacheWrite1h: scale, reasoning: 2 * scale, totalTokens: 22 * scale,
		cost: { input: scale / 8, output: scale / 4, cacheRead: scale / 16, cacheWrite: scale / 32, total: 15 * scale / 32 },
	};
}

function assistant(scale = 1, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text: "PRIVATE_SIDE_ANSWER" }],
		api: model.api, provider: model.provider, model: model.id,
		usage: usage(scale), stopReason: "stop", timestamp: 1,
		...overrides,
	};
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function checkpoint() {
	const reached = deferred();
	const resume = deferred();
	return {
		reached: reached.promise,
		resume: () => resume.resolve(),
		wait: async () => { reached.resolve(); await resume.promise; },
	};
}

type Script = (child: FakeChild) => Promise<void>;
type Command = Pick<sdk.RegisteredCommand, "handler">;

class FakeChild {
	manager: sdk.SessionManager;
	model: Model<any>;
	private listeners = new Set<(event: sdk.AgentSessionEvent) => void>();
	private script: Script;
	private abortScript: Script;
	private running: Promise<void> | undefined;
	readonly prompted = deferred();
	readonly seed: sdk.SessionEntry[];

	constructor(manager: sdk.SessionManager, selectedModel: Model<any>, script: Script, abortScript: Script) {
		this.manager = manager;
		this.model = selectedModel;
		this.script = script;
		this.abortScript = abortScript;
		this.seed = structuredClone(manager.getEntries());
	}

	get messages() { return this.manager.buildSessionContext().messages; }
	subscribe = mock.fn((listener: (event: sdk.AgentSessionEvent) => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	});
	emit(event: sdk.AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
	complete(message: AssistantMessage, beforeWrite?: () => void): void {
		this.emit({ type: "message_update", message } as sdk.AgentSessionEvent);
		// AgentSession dispatches message_end BEFORE appending the completed message.
		this.emit({ type: "message_end", message });
		beforeWrite?.();
		this.manager.appendMessage(message);
	}
	boundary(type: "turn_end" | "agent_end" | "compaction_end"): void {
		this.emit({ type, messages: this.messages, willRetry: false, aborted: false } as sdk.AgentSessionEvent);
	}
	prompt = mock.fn(async (question: string, _options: unknown) => {
		this.manager.appendMessage({ role: "user", content: question, timestamp: 2 });
		this.running = this.script(this);
		this.prompted.resolve();
		await this.running;
	});
	abort = mock.fn(async () => {
		await this.abortScript(this);
		await this.running;
	});
	dispose = mock.fn(() => { this.listeners.clear(); });
	setModel = mock.fn(async (selectedModel: Model<any>) => { this.model = selectedModel; });
	setThinkingLevel = mock.fn((_level: string) => {});
}

class FakeResourceLoader {
	options: ConstructorParameters<typeof sdk.DefaultResourceLoader>[0];
	constructor(options: ConstructorParameters<typeof sdk.DefaultResourceLoader>[0]) { this.options = options; }
	reload = mock.fn(async () => {});
}

function rows(manager: sdk.SessionManager) {
	return manager.getEntries().flatMap((entry) => entry.type === "usage" && entry.kind === "btw"
		? [{ provider: entry.provider, model: entry.model, usage: entry.usage }]
		: []);
}

function expected(scale: number, provider = model.provider, modelId = model.id) {
	return { provider, model: modelId, usage: usage(scale) };
}

// Import the real SDK first; only the child factory and disk resource discovery are replaced.
// All subtests are serial because the mocked factory is selected by their harness.
test("registered /btw integration", { concurrency: false, timeout: 15_000 }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-btw-wiring-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	let factory: (options: sdk.CreateAgentSessionOptions) => Promise<{ session: FakeChild }>;
	t.mock.module("@earendil-works/pi-coding-agent", {
		namedExports: {
			...sdk,
			createAgentSession: (options: sdk.CreateAgentSessionOptions) => factory(options),
			DefaultResourceLoader: FakeResourceLoader,
			getAgentDir: () => dir,
		},
	});
	const { default: btw } = await import("../extensions/btw.ts");

	function harness(testContext: TestContext, holdInitialization = false) {
		const parent = sdk.SessionManager.inMemory(dir);
		parent.appendMessage({ role: "user", content: "MAIN QUESTION", timestamp: 0 });
		parent.appendMessage(assistant(64, { content: [{ type: "text", text: "MAIN ANSWER" }] }));
		parent.appendUsage("cache_warm", "main-provider", "main-model", usage(128));
		const originalEntries = structuredClone(parent.getEntries());
		const originalContext = structuredClone(parent.buildSessionContext());
		const commands = new Map<string, Command>();
		const shortcuts = new Map<string, { handler: () => void }>();
		const events = new Map<string, () => Promise<void>>();
		const thinking = mock.fn(() => "low" as const);
		btw({
			registerCommand: (name: string, command: Command) => commands.set(name, command),
			registerShortcut: (key: string, shortcut: { handler: () => void }) => shortcuts.set(key, shortcut),
			on: (event: string, handler: () => Promise<void>) => events.set(event, handler),
			getThinkingLevel: thinking,
		} as unknown as sdk.ExtensionAPI);
		const ui = { custom: mock.fn(async () => undefined), notify: mock.fn((_message: string, _level: string) => {}) };
		const ctx = {
			cwd: dir, mode: "tui", sessionManager: parent, model, ui,
			getSystemPromptOptions: () => ({ customPrompt: "MAIN SYSTEM PROMPT", appendSystemPrompt: "MAIN RULES" }),
		} as unknown as sdk.ExtensionCommandContext;
		const created = deferred<FakeChild>();
		const initialization = deferred();
		const calls: sdk.CreateAgentSessionOptions[] = [];
		const children: FakeChild[] = [];
		const pauses: ReturnType<typeof checkpoint>[] = [];
		let script: Script = async (child) => { child.complete(assistant()); child.boundary("turn_end"); };
		let abortScript: Script = async () => {};
		factory = async (options) => {
			calls.push(options);
			const child = new FakeChild(options.sessionManager!, options.model!, (c) => script(c), (c) => abortScript(c));
			children.push(child);
			created.resolve(child);
			await initialization.promise;
			return { session: child };
		};
		if (!holdInitialization) initialization.resolve();
		const shutdown = () => events.get("session_shutdown")!();
		testContext.after(async () => {
			initialization.resolve();
			for (const pause of pauses) pause.resume();
			await shutdown();
		});
		return {
			parent, originalEntries, originalContext, ctx, ui, commands, shortcuts, events, thinking, calls, children,
			created: created.promise, releaseInitialization: () => initialization.resolve(), shutdown,
			ask: (question: string, context = ctx) => commands.get("btw")!.handler(question, context),
			script: (value: Script) => { script = value; },
			onAbort: (value: Script) => { abortScript = value; },
			pause: () => { const pause = checkpoint(); pauses.push(pause); return pause; },
			assertClean: () => {
				assert.deepEqual(parent.buildSessionContext(), originalContext, "side content must not enter parent context");
				assert.deepEqual(parent.getEntries().slice(0, originalEntries.length), originalEntries);
				assert.ok(parent.getEntries().slice(originalEntries.length).every((e) => e.type === "usage" && e.kind === "btw"));
				assert.equal(JSON.stringify(parent.getEntries()).includes("PRIVATE_SIDE_"), false);
			},
		};
	}

	await t.test("registers lazily, guards non-TUI mode and opens an empty overlay without a child", async (t) => {
		const h = harness(t);
		assert.deepEqual([...h.commands.keys()], ["btw"]);
		assert.deepEqual([...h.shortcuts.keys()], ["alt+/", "ctrl+alt+w"]);
		assert.deepEqual([...h.events.keys()], ["session_shutdown"]);
		for (const shortcut of h.shortcuts.values()) shortcut.handler();
		await h.ask("question", { ...h.ctx, mode: "json" });
		assert.match(h.ui.notify.mock.calls[0].arguments[0], /requires interactive TUI/);
		assert.equal(h.ui.custom.mock.callCount(), 0);
		await h.ask("  ");
		assert.equal(h.ui.custom.mock.callCount(), 1);
		assert.equal(h.calls.length, 0);
		assert.equal(h.thinking.mock.callCount(), 0);
		assert.deepEqual(rows(h.parent), []);
		h.assertClean();
	});

	await t.test("each persisted event boundary updates live totals once, excluding seeded parent usage", async (t) => {
		const h = harness(t);
		const boundaries = ["turn_end", "entry_appended", "compaction_end", "agent_end"] as const;
		const pauses = boundaries.map(() => h.pause());
		const beforeWrite: ReturnType<typeof rows>[] = [];
		h.script(async (child) => {
			for (const [index, boundary] of boundaries.entries()) {
				if (boundary === "entry_appended") {
					const entry = child.manager.appendUsage("cache_warm", "native-provider", "native-model", usage(2));
					child.emit({ type: boundary, entry });
					child.emit({ type: boundary, entry });
				} else {
					if (boundary === "compaction_end") {
						child.manager.appendCompaction("PRIVATE_SIDE_SUMMARY", null, 100, undefined, false, usage(3));
					} else {
						child.complete(assistant(index + 1, { responseModel: "physical-model" }), () => beforeWrite.push(rows(h.parent)));
					}
					child.boundary(boundary);
					child.boundary(boundary);
				}
				await pauses[index].wait();
			}
		});
		let settled = false;
		const ask = h.ask("  PRIVATE_SIDE_QUESTION  ").then(() => { settled = true; });
		const expectedRows = [expected(1, model.provider, "physical-model"), expected(2, "native-provider", "native-model"), expected(3), expected(4, model.provider, "physical-model")];
		for (const [index, pause] of pauses.entries()) {
			await pause.reached;
			assert.equal(settled, false, "usage is visible while prompt() is still pending");
			assert.deepEqual(rows(h.parent), expectedRows.slice(0, index + 1));
			assert.equal(rows(h.parent).reduce((sum, row) => sum + row.usage.cost.total, 0), usage((index + 1) * (index + 2) / 2).cost.total);
			h.assertClean();
			pause.resume();
		}
		await ask;
		const child = await h.created;
		assert.deepEqual(beforeWrite, [[], expectedRows.slice(0, 3)], "message_end itself precedes journal persistence");
		assert.ok(child.manager instanceof sdk.SessionManager);
		assert.equal(child.manager.isPersisted(), false);
		assert.notEqual(child.manager, h.parent);
		assert.deepEqual(child.seed.map((entry) => entry.type === "message" ? entry.message : entry), h.originalContext.messages);
		assert.equal(child.subscribe.mock.callCount(), 1);
		assert.deepEqual(child.prompt.mock.calls[0].arguments, ["PRIVATE_SIDE_QUESTION", { source: "extension" }]);
		assert.deepEqual(h.calls[0].tools, ["read", "grep", "find", "ls"]);
		assert.equal(h.calls[0].thinkingLevel, "low");
		assert.ok(h.calls[0].settingsManager instanceof sdk.SettingsManager);
		const loader = h.calls[0].resourceLoader as unknown as FakeResourceLoader;
		assert.ok(loader instanceof FakeResourceLoader);
		assert.equal(loader.reload.mock.callCount(), 1);
		assert.equal(loader.options?.agentDir, dir);
		assert.equal(loader.options?.noExtensions, true);
		assert.equal(loader.options?.systemPrompt, "MAIN SYSTEM PROMPT");
		assert.equal(loader.options?.appendSystemPrompt?.[0], "MAIN RULES");
		await h.shutdown();
		assert.deepEqual(rows(h.parent), expectedRows, "finally and shutdown must not duplicate event accounting");
		assert.equal(h.ui.notify.mock.callCount(), 0);
		h.assertClean();
	});

	await t.test("records assistant usage before a slow tool finishes", async (t) => {
		const h = harness(t);
		const tool = h.pause();
		h.script(async (child) => {
			child.complete(assistant(2, { stopReason: "toolUse" }));
			child.emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} });
			await tool.wait();
			child.manager.appendMessage({
				role: "toolResult", toolCallId: "read-1", toolName: "read",
				content: [], isError: false, timestamp: 3,
			});
			child.boundary("turn_end");
		});
		const ask = h.ask("PRIVATE_SIDE_QUESTION");
		await tool.reached;
		assert.deepEqual(rows(h.parent), [expected(2)]);
		tool.resume();
		await ask;
		assert.deepEqual(rows(h.parent), [expected(2)]);
		h.assertClean();
	});

	for (const stopReason of ["aborted", "error"] as const) {
		await t.test(`completed ${stopReason} responses keep billed usage`, async (t) => {
			const h = harness(t);
			const pause = h.pause();
			h.script(async (child) => {
				child.complete(assistant(3, { stopReason, errorMessage: "Partial response" }));
				child.boundary("turn_end");
				child.boundary("agent_end");
				await pause.wait();
			});
			const ask = h.ask("PRIVATE_SIDE_QUESTION");
			await pause.reached;
			assert.deepEqual(rows(h.parent), [expected(3)]);
			pause.resume();
			await ask;
			await h.shutdown();
			assert.deepEqual(rows(h.parent), [expected(3)]);
			h.assertClean();
		});
	}

	await t.test("a thrown prompt without any terminal event drains journal usage in finally", async (t) => {
		const h = harness(t);
		const pause = h.pause();
		h.script(async (child) => {
			child.complete(assistant(5));
			await pause.wait();
			throw new Error("synthetic prompt failure");
		});
		const ask = h.ask("PRIVATE_SIDE_QUESTION");
		await pause.reached;
		assert.deepEqual(rows(h.parent), [], "message_end is too early to read the completed journal entry");
		pause.resume();
		await ask;
		assert.deepEqual(rows(h.parent), [expected(5)]);
		await h.shutdown();
		assert.deepEqual(rows(h.parent), [expected(5)]);
		h.assertClean();
	});

	await t.test("overlapping initialization reserves a single child and recorder for the original parent", async (t) => {
		const h = harness(t, true);
		const otherParent = sdk.SessionManager.inMemory(dir);
		const ask = h.ask("first");
		const child = await h.created;
		await Promise.all([h.ask("second"), h.ask("wrong parent", { ...h.ctx, sessionManager: otherParent })]);
		assert.equal(h.calls.length, 1);
		assert.equal(child.prompt.mock.callCount(), 0);
		h.releaseInitialization();
		await ask;
		assert.equal(child.prompt.mock.callCount(), 1);
		assert.deepEqual(rows(h.parent), [expected(1)]);
		await h.ask("next exchange");
		assert.equal(h.calls.length, 1, "subsequent questions reuse the initialized child");
		assert.equal(child.subscribe.mock.callCount(), 1);
		assert.deepEqual(child.prompt.mock.calls.map((call) => call.arguments[0]), ["first", "next exchange"]);
		assert.deepEqual(rows(h.parent), [expected(1), expected(1)]);
		assert.deepEqual(otherParent.getEntries(), []);
		h.assertClean();
	});

	await t.test("shutdown aborts, waits for the prompt, drains usage and disposes exactly once", async (t) => {
		const h = harness(t);
		const promptPause = h.pause();
		const abortPause = h.pause();
		h.script(async (child) => {
			child.complete(assistant(1, { stopReason: "toolUse" }));
			child.boundary("turn_end");
			await promptPause.wait();
		});
		h.onAbort(async (child) => {
			await abortPause.wait();
			child.complete(assistant(2, { stopReason: "aborted" })); // No final event: finally must drain it.
			promptPause.resume();
		});
		const ask = h.ask("PRIVATE_SIDE_QUESTION");
		await promptPause.reached;
		const child = await h.created;
		const shutdown = h.shutdown();
		await abortPause.reached;
		assert.equal(child.abort.mock.callCount(), 1);
		assert.equal(child.dispose.mock.callCount(), 0, "dispose must not race the pending prompt");
		const otherParent = sdk.SessionManager.inMemory(dir);
		await h.ask("too late", { ...h.ctx, sessionManager: otherParent });
		assert.equal(child.prompt.mock.callCount(), 1);
		abortPause.resume();
		await Promise.all([ask, shutdown]);
		assert.deepEqual(rows(h.parent), [expected(1), expected(2)]);
		assert.equal(child.dispose.mock.callCount(), 1);
		child.manager.appendMessage(assistant(99));
		child.boundary("turn_end");
		// Also simulate a callback already queued before dispose removed the listener.
		child.subscribe.mock.calls[0].arguments[0]({ type: "agent_end", messages: child.messages, willRetry: false });
		await h.ask("still too late");
		await h.shutdown();
		assert.equal(h.calls.length, 1);
		assert.equal(child.prompt.mock.callCount(), 1);
		assert.equal(child.dispose.mock.callCount(), 1);
		assert.deepEqual(rows(h.parent), [expected(1), expected(2)]);
		assert.deepEqual(otherParent.getEntries(), []);
		h.assertClean();
	});

	await t.test("in-flight events and final drains never charge a replacement parent session", async (t) => {
		const h = harness(t);
		const pause = h.pause();
		h.script(async (child) => {
			await pause.wait();
			child.complete(assistant(6));
			child.boundary("turn_end");
			child.boundary("agent_end");
		});
		const ask = h.ask("PRIVATE_SIDE_QUESTION");
		await pause.reached;
		const oldId = h.parent.getSessionId();
		h.parent.newSession();
		assert.notEqual(h.parent.getSessionId(), oldId);
		pause.resume();
		await ask;
		await h.shutdown();
		assert.deepEqual(h.parent.getEntries(), [], "old child usage must not leak into /new");
		assert.ok(h.ui.notify.mock.callCount() > 0);
		for (const notification of h.ui.notify.mock.calls) {
			assert.match(notification.arguments[0], /Failed to record \/btw usage:.*parent session changed/);
			assert.equal(notification.arguments[1], "error");
		}
		assert.equal((await h.created).dispose.mock.callCount(), 1);
	});

	await t.test("idle shutdown flushes a journal entry with no event", async (t) => {
		const h = harness(t);
		await h.ask("PRIVATE_SIDE_QUESTION");
		const child = await h.created;
		child.manager.appendUsage("background", model.provider, model.id, usage(7));
		assert.deepEqual(rows(h.parent), [expected(1)]);
		await h.shutdown();
		assert.deepEqual(rows(h.parent), [expected(1), expected(7)]);
		assert.equal(child.abort.mock.callCount(), 0);
		assert.equal(child.dispose.mock.callCount(), 1);
		h.assertClean();
	});

	for (const boundary of ["agent_start", "compaction_start"] as const) {
		await t.test(`shutdown cancels a late ${boundary} after asynchronous prompt preflight`, async (t) => {
			const h = harness(t);
			const auth = h.pause();
			let cancelled = false;
			let providerRequests = 0;
			h.script(async (child) => {
				await auth.wait();
				child.emit({ type: boundary, reason: "threshold" } as sdk.AgentSessionEvent);
				if (!cancelled) providerRequests++;
			});
			h.onAbort(async () => { cancelled = true; });
			const ask = h.ask("PRIVATE_SIDE_QUESTION");
			await auth.reached;
			const child = await h.created;
			// Native abort() returns immediately while prompt() awaits authentication:
			// there is no active run yet, so its cancellation does not affect a later run.
			child.abort.mock.mockImplementationOnce(async () => {});
			const shutdown = h.shutdown();
			assert.equal(child.abort.mock.callCount(), 1);
			assert.equal(cancelled, false);
			auth.resume();
			await Promise.all([ask, shutdown]);
			assert.equal(child.abort.mock.callCount(), 2, "cancel again at the late start boundary");
			assert.equal(providerRequests, 0, "shutdown must not allow a late provider request");
			assert.equal(child.dispose.mock.callCount(), 1);
			assert.deepEqual(rows(h.parent), []);
			h.assertClean();
		});
	}

	await t.test("shutdown during initialization waits, disposes the late child and never prompts it", async (t) => {
		const h = harness(t, true);
		const ask = h.ask("PRIVATE_SIDE_QUESTION");
		const child = await h.created;
		let closed = false;
		const shutdown = h.shutdown().then(() => { closed = true; });
		const otherParent = sdk.SessionManager.inMemory(dir);
		await h.ask("late submission", { ...h.ctx, sessionManager: otherParent });
		assert.equal(closed, false);
		assert.equal(child.dispose.mock.callCount(), 0);
		h.releaseInitialization();
		await Promise.all([ask, shutdown]);
		assert.equal(child.prompt.mock.callCount(), 0);
		assert.equal(child.abort.mock.callCount(), 0);
		assert.equal(child.dispose.mock.callCount(), 1);
		assert.deepEqual(h.parent.getEntries(), h.originalEntries, "seeded main usage is not billed again on shutdown");
		await h.ask("after shutdown");
		assert.equal(h.calls.length, 1);
		assert.deepEqual(otherParent.getEntries(), []);
		h.assertClean();
	});
});
