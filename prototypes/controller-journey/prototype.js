const variants = [
  { key: "A", name: "Guided conversation", render: renderConversation },
  { key: "B", name: "Selected hybrid cockpit", render: renderCockpit },
  { key: "C", name: "Runbook timeline", render: renderTimeline },
];

const state = {
  project: "token-maxxing",
  location: "devbox · /home/dylan/projects/token-maxxing",
  harness: "sandcastle@8fe1c4a",
  run: "run-2026-07-30-014",
  phase: "Awaiting launch approval",
};

function sharedStatus() {
  return `<div class="status-strip"><span><b>Project</b> ${state.project}</span><span><b>Host</b> devbox · online</span><span><b>Harness</b> ${state.harness}</span></div>`;
}

function renderConversation() {
  return `<section class="conversation shell">
    <header><p class="eyebrow">CLAUDE CODE · SAND-KING</p><h1>Pick up where the Project left off</h1></header>
    ${sharedStatus()}
    <div class="chat">
      <article class="person">Open my token-maxxing Project on devbox.</article>
      <article class="controller"><b>Controller</b><p>I found the registered Project over SSH. Its Host is current and the Project pins <code>${state.harness}</code>.</p><div class="receipt">✓ SSH identity verified &nbsp; ✓ Project unchanged &nbsp; ✓ 3 prior Harness runs</div></article>
      <article class="controller"><b>Controller</b><p>Wayfinding found one ready decision: define the recovery contract. I prepared a Launch request using the pinned Harness.</p><div class="proposal"><h2>Launch request</h2><dl><dt>Backlog</dt><dd>First unclaimed, unblocked issue</dd><dt>Access</dt><dd>Project + GitHub credentials</dd><dt>Continuity</dt><dd>Run survives this Controller disconnecting</dd></dl><button>Approve and launch</button><button class="quiet">Revise</button></div></article>
      <article class="controller muted"><b>What happens next</b><p>Claude Code may disconnect. Reopen this Project from any Controller to observe the same Harness run, request cancellation, or review its structured result.</p></article>
    </div>
    <footer class="composer">Ask about the Project or direct interactive work… <span>↵</span></footer>
  </section>`;
}

function renderCockpit() {
  return `<section class="cockpit shell">
    <aside><div class="brand">SAND—KING</div><a class="active">⌁ Home</a><a>▣ Projects</a><a>◇ Harnesses</a><a>⌁ Hosts</a><p class="nav-title">RECENT PROJECTS</p><a>token-maxxing <i>live</i></a><a>sandking</a><p class="nav-title">CONTROLLER SESSIONS</p><a class="session-active">Wayfinder · recovery</a><a>General Project chat</a><a>Release investigation</a><button class="primary">＋ New session</button></aside>
    <div class="workspace">
      <header><div><p class="eyebrow">PROJECT / ${state.location}</p><h1>${state.project} <small>› WAYFINDER EFFORT</small></h1></div><button>Open externally in Claude Code</button></header>
      <div class="effort-tabs"><b>Controller Chat</b><b class="selected">Wayfinder efforts <i>2</i></b><b>Harness runs <i>1</i></b><b>Settings</b></div>
      <div class="effort-heading"><div><p class="eyebrow">CHART THE RECOVERY CONTRACT</p><h2>Make recovery behavior implementation-ready</h2></div><a>Open canonical map ↗</a></div>
      <div class="workbench"><article class="terminal"><div class="terminal-bar"><span>Claude Code · ticket-focused session</span><span>● synced &nbsp; ↗</span></div><div class="terminal-body"><p class="prompt">❯ Start the next unblocked decision.</p><p class="claude"><b>Claude</b> I’ve claimed <u>Define recovery fallback behavior</u>. The Host can retain the latest verified provider-session bundle and a portable Controller handoff.</p><p class="claude">When exact restore fails, should Sand-King automatically continue from the handoff after warning you, or stop?</p><p class="prompt active">❯ Automatically fall back, but clearly tell me what happened.<i></i></p></div></article>
      <article class="tickets"><div class="ticket-head"><h2>Decision tickets</h2><button>＋</button></div><p class="section-label">FRONTIER</p><div class="ticket selected"><span class="pulse"></span><div><b>Define recovery fallback behavior</b><p>Grilling · claimed in this session</p></div><em>↗</em></div><div class="ticket"><span>○</span><div><b>Choose cockpit delivery stack</b><p>Grilling · start</p></div><button>Start</button></div><p class="section-label">BLOCKED</p><div class="ticket disabled"><span>⊘</span><div><b>Validate recovery criteria</b><p>Blocked by 2 decisions</p></div><em>↗</em></div><p class="section-label">RESOLVED</p><div class="ticket disabled"><span class="done">✓</span><div><b>Define persistent state</b><p>Resolution recorded on GitHub</p></div><em>↗</em></div></article></div>
      <div class="bottom-cards"><article><small>ACTIVE HARNESS RUN</small><b>Define recovery contract</b><span>${state.run} · awaiting approval</span><a>Open dedicated run view →</a></article><article><small>PINNED HARNESS</small><b>sandcastle@8fe1c4a</b><span>Healthy · 3 linked Projects</span><a>Open Harness workspace →</a></article></div>
    </div>
  </section>`;
}

function renderTimeline() {
  return `<section class="timeline shell">
    <header><div><p class="eyebrow">SAND-KING / ${state.project}</p><h1>Recovery contract journey</h1></div><span class="connected">● Host connected over SSH</span></header>
    ${sharedStatus()}
    <div class="journey"><nav><a class="complete">1 <span>Open Project<small>Resolved on devbox</small></span></a><a class="complete">2 <span>Initialize<small>Registration reused</small></span></a><a class="complete">3 <span>Wayfind<small>Decision selected</small></span></a><a class="current">4 <span>Launch<small>Approval required</small></span></a><a>5 <span>Observe<small>Across Controllers</small></span></a><a>6 <span>Review<small>Result and changes</small></span></a></nav>
      <article class="stage"><p class="eyebrow">STEP 4 OF 6 · PERSON REQUIRED</p><h2>Approve a durable Harness run</h2><p class="lede">The Controller has translated the selected Wayfinder decision into a typed Launch request. Nothing starts until you approve.</p><div class="manifest"><div><small>PROJECT</small><b>${state.project}</b><span>${state.location}</span></div><div><small>WORK</small><b>First ready backlog item</b><span>Define recovery contract</span></div><div><small>HARNESS</small><b>${state.harness}</b><span>Exact revision pinned</span></div><div><small>AFTER DISCONNECT</small><b>Continue on Host</b><span>Resume with run cursor</span></div></div><details open><summary>Capabilities requested</summary><p>Read/write Project · Git operations · GitHub issue updates · no privileged Host mutation</p></details><div class="actions"><button class="launch">Approve and begin</button><button class="quiet">Back to Wayfinding</button></div><p class="handoff">Next: disconnect safely, then open <code>${state.run}</code> from another Controller to observe it.</p></article>
    </div>
  </section>`;
}

function currentVariant() {
  const key = new URLSearchParams(location.search).get("variant")?.toUpperCase();
  return variants.find((variant) => variant.key === key) ?? variants[0];
}

function show(key) {
  const url = new URL(location.href);
  url.searchParams.set("variant", key);
  history.replaceState({}, "", url);
  render();
}

function cycle(offset) {
  const current = currentVariant();
  const index = variants.findIndex((variant) => variant.key === current.key);
  show(variants[(index + offset + variants.length) % variants.length].key);
}

function render() {
  const variant = currentVariant();
  document.querySelector("#app").innerHTML = variant.render();
  document.querySelector("#variant-label").textContent = `${variant.key} — ${variant.name}`;
}

document.querySelector("#previous").addEventListener("click", () => cycle(-1));
document.querySelector("#next").addEventListener("click", () => cycle(1));
document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA"].includes(event.target.tagName) || event.target.isContentEditable) return;
  if (event.key === "ArrowLeft") cycle(-1);
  if (event.key === "ArrowRight") cycle(1);
});
render();
