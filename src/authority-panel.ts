export const AUTHORITY_PANEL_URI = "ui://latch-authority/panel.html";

/** A dependency-free MCP Apps component; all authority state stays on the server. */
export function authorityPanelHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LATCH Authority</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 18px; color: CanvasText; background: Canvas; }
      header { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 16px; }
      h1 { font-size: 16px; margin: 0; letter-spacing: .06em; }
      h2 { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; margin: 22px 0 8px; color: GrayText; }
      p { color: GrayText; font-size: 12px; line-height: 1.45; margin: 5px 0 0; }
      button { appearance: none; border: 1px solid color-mix(in srgb, CanvasText 28%, Canvas); border-radius: 7px; background: Canvas; color: CanvasText; padding: 6px 9px; cursor: pointer; font: inherit; font-size: 11px; }
      button:hover { border-color: #0a9c6c; color: #0a9c6c; }
      button.warn:hover { border-color: #c27a00; color: #c27a00; }
      button.danger:hover { border-color: #c74242; color: #c74242; }
      input { min-width: 180px; flex: 1 1 180px; border: 1px solid color-mix(in srgb, CanvasText 28%, Canvas); border-radius: 7px; background: Canvas; color: CanvasText; padding: 6px 9px; font: inherit; font-size: 11px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; }
      .card { border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas); border-radius: 10px; padding: 11px; min-width: 0; }
      .line { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
      .path { overflow-wrap: anywhere; font-size: 12px; font-weight: 700; }
      .meta { color: GrayText; font-size: 10px; margin-top: 7px; overflow-wrap: anywhere; }
      .status { border-radius: 999px; font-size: 10px; padding: 3px 6px; border: 1px solid currentColor; white-space: nowrap; }
      .open, .applied { color: #0a9c6c; } .held, .pending { color: #c27a00; } .objected, .expired { color: #c74242; } .approved { color: #5275d9; } .draft { color: GrayText; }
      .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      #notice { min-height: 18px; font-size: 11px; color: GrayText; }
      #notice.error { color: #c74242; } #notice.ok { color: #0a9c6c; }
      .empty { border: 1px dashed color-mix(in srgb, CanvasText 28%, Canvas); border-radius: 10px; padding: 16px; color: GrayText; font-size: 12px; }
    </style>
  </head>
  <body>
    <header>
      <div><h1>LATCH AUTHORITY</h1><p>Visible, per-scope control for agent-assisted coding.</p></div>
      <button id="refresh">Refresh</button>
    </header>
    <div id="notice">Waiting for authority state…</div>
    <section><h2>Scopes</h2><div id="scopes" class="grid"></div></section>
    <section><h2>Proposals</h2><div id="proposals" class="grid"></div></section>
    <script>
      const scopes = document.getElementById("scopes");
      const proposals = document.getElementById("proposals");
      const notice = document.getElementById("notice");
      const pending = new Map();
      let nextId = 1;
      let latestState = null;
      let refreshInFlight = false;
      const standalone = window.parent === window;

      function request(method, params) {
        if (standalone) {
          return fetch("/api/tools/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ method, params }),
          }).then(async (response) => {
            const reply = await response.json();
            if (!response.ok) throw new Error(reply.error || "Local panel request failed.");
            return reply;
          });
        }
        const id = nextId++;
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      }
      function say(text, kind = "") { notice.textContent = text; notice.className = kind; }
      function errorText(error) {
        if (error instanceof Error && error.message) return error.message;
        if (error && typeof error === "object") {
          const value = error;
          const text = value.message || value.data?.message || value.data?.content?.[0]?.text || value.content?.[0]?.text;
          if (typeof text === "string" && text) return text;
          try { return JSON.stringify(value); } catch { return "Tool call failed."; }
        }
        return String(error || "Tool call failed.");
      }
      function toolError(reply) {
        if (!reply) return undefined;
        const value = reply.result || reply;
        return value.isError ? value.content?.[0]?.text || "Tool call failed." : undefined;
      }
      function toolState(reply) {
        const value = reply?.result || reply;
        return value?.structuredContent || value?.data?.structuredContent;
      }
      function clear(element) { while (element.firstChild) element.removeChild(element.firstChild); }
      function empty(element, text) { const node = document.createElement("div"); node.className = "empty"; node.textContent = text; element.appendChild(node); }
      function badge(status) { const node = document.createElement("span"); node.className = "status " + status.toLowerCase(); node.textContent = status; return node; }
      function card() { const node = document.createElement("article"); node.className = "card"; return node; }
      function button(label, className, onClick) { const node = document.createElement("button"); node.textContent = label; node.className = className; node.onclick = onClick; return node; }
      function actions(node) { const value = document.createElement("div"); value.className = "actions"; node.appendChild(value); return value; }
      function addLine(node, label, value) { const line = document.createElement("div"); line.className = "meta"; line.textContent = label + value; node.appendChild(line); }
      async function callTool(name, args) {
        try {
          say("Working…");
          const reply = await request("tools/call", { name, arguments: args });
          const failed = toolError(reply);
          if (failed) throw new Error(failed);
          const state = toolState(reply);
          if (state?.scopes && state?.proposals) render(state);
          await refresh();
          say("Authority state updated.", "ok");
        } catch (error) { say(errorText(error), "error"); }
      }
      function render(state) {
        latestState = state;
        clear(scopes); clear(proposals);
        if (!state?.scopes?.length) empty(scopes, "No scopes declared yet.");
        for (const scope of state?.scopes || []) {
          const node = card(); const line = document.createElement("div"); line.className = "line";
          const path = document.createElement("div"); path.className = "path"; path.textContent = scope.path; line.append(path, badge(scope.status)); node.appendChild(line);
          addLine(node, "id: ", scope.id); addLine(node, "revision: ", String(scope.revision)); if (scope.reason) addLine(node, "reason: ", scope.reason);
          const area = actions(node);
          if (scope.status === "OPEN") area.appendChild(button("HOLD", "warn", () => callTool("hold_scope", { scope_id: scope.id })));
          else area.appendChild(button("RELEASE", "", () => callTool("release_scope", { scope_id: scope.id })));
          scopes.appendChild(node);
        }
        if (!state?.proposals?.length) empty(proposals, "No proposals yet.");
        for (const proposal of state?.proposals || []) {
          const node = card(); const line = document.createElement("div"); line.className = "line";
          const title = document.createElement("div"); title.className = "path"; title.textContent = proposal.id; line.append(title, badge(proposal.status)); node.appendChild(line);
          if (proposal.summary) addLine(node, "summary: ", proposal.summary);
          addLine(node, "files: ", proposal.operations.map((operation) => operation.path).join(", "));
          if (proposal.objection) addLine(node, "objection: ", proposal.objection);
          const area = actions(node);
          const decision = (state.decisions || []).find((item) => item.proposalId === proposal.id);
          if (proposal.status === "PENDING") {
            const reason = document.createElement("input"); reason.placeholder = "Reason required to object"; reason.setAttribute("aria-label", "Reason for objecting to " + proposal.id); area.appendChild(reason);
            area.appendChild(button("OBJECT", "danger", () => {
              const text = reason.value.trim();
              if (!text) { say("Enter a reason before objecting.", "error"); reason.focus(); return; }
              callTool("object_proposal", { proposal_id: proposal.id, reason: text });
            }));
            if (!decision?.allowed && decision?.blockingScopeIds?.length) {
              area.appendChild(button("APPROVE EXACT", "", () => callTool("approve_proposal", { proposal_id: proposal.id })));
            }
          }
          proposals.appendChild(node);
        }
        say("Authority state is current.", "ok");
      }
      async function refresh() {
        if (refreshInFlight) return;
        refreshInFlight = true;
        try {
          const reply = await request("tools/call", { name: "get_authority_state", arguments: {} });
          const failed = toolError(reply);
          if (failed) throw new Error(failed);
          const state = toolState(reply);
          if (!state) throw new Error("The host returned no authority state.");
          render(state);
        } finally {
          refreshInFlight = false;
        }
      }
      document.getElementById("refresh").onclick = () => refresh().catch((error) => say(errorText(error), "error"));
      window.addEventListener("focus", () => refresh().catch((error) => say(errorText(error), "error")));
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refresh().catch((error) => say(errorText(error), "error"));
      });
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.id !== undefined && pending.has(message.id)) {
          const deferred = pending.get(message.id); pending.delete(message.id);
          if (message.error) deferred.reject(message.error); else deferred.resolve(message.result); return;
        }
        const initial = message.params?.toolResult?.structuredContent || message.params?.toolOutput?.structuredContent || message.params?.structuredContent;
        if ((message.method === "ui/initialize" || message.method === "ui/notifications/tool-result") && initial) render(initial);
      }, { passive: true });
      // The host may mount this iframe after its initial focus event. Fetch once on
      // mount so the panel never depends on the user pressing Refresh first.
      queueMicrotask(() => refresh().catch((error) => say(errorText(error), "error")));
    </script>
  </body>
</html>`;
}
