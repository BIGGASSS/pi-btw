import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

interface ModelIdentity {
	provider: string;
	id: string;
}

/** Forward only new side-session billing records, never its seeded main-session history. */
export function createBtwUsageRecorder(
	parent: ReadonlySessionManager,
	child: ReadonlySessionManager,
	getModel: () => ModelIdentity,
): () => boolean {
	// Extension contexts expose a read-only view, but currently return the actual
	// manager. Keep this SDK escape hatch narrow: custom entries do NOT contribute
	// to pi's totals, whereas native usage entries do and never enter LLM context.
	const writer = parent as ReadonlySessionManager & Pick<SessionManager, "appendUsage">;
	if (typeof writer.appendUsage !== "function") {
		throw new Error("/btw usage accounting requires pi 1.4.0 or newer. Please update pi.");
	}
	const parentId = parent.getSessionId();
	let cursor = child.getEntries().length;

	return () => {
		if (parent.getSessionId() !== parentId) {
			throw new Error("Cannot record /btw usage: the parent session changed.");
		}
		let recorded = false;
		const entries = child.getEntries();
		while (cursor < entries.length) {
			const entry = entries[cursor++];
			let usage: Usage | undefined;
			let model = getModel();
			let note: string = entry.type;
			if (entry.type === "message" && entry.message.role === "assistant") {
				usage = entry.message.usage;
				model = { provider: entry.message.provider, id: entry.message.responseModel ?? entry.message.model };
				note = "assistant";
			} else if (entry.type === "message" && entry.message.role === "toolResult") {
				usage = entry.message.usage;
				note = "toolResult";
			} else if (entry.type === "usage") {
				usage = entry.usage;
				model = { provider: entry.provider, id: entry.model };
				note = entry.kind;
			} else if (entry.type === "compaction" || entry.type === "branch_summary") {
				usage = entry.usage;
			}
			if (!usage) continue;
			// Copy rather than retain mutable objects owned by the child. Advance the
			// cursor before appending: the manager updates memory before writing disk,
			// so retrying a failed disk write would double-count its in-memory entry.
			writer.appendUsage("btw", model.provider, model.id, structuredClone(usage), note);
			recorded = true;
		}
		return recorded;
	};
}
