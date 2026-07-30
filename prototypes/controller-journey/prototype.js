const variants = [
  { key: "A", name: "Guided conversation", render: renderConversation },
  { key: "B", name: "Operations cockpit", render: renderCockpit },
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
    <aside><div class="brand">SAND—KING</div><button class="primary">＋ Open Project</button><p class="nav-title">PROJECTS</p><a class="active">token-maxxing <i>live</i></a><a>sandking</a><a>course-platform</a><p class="nav-title">HOSTS</p><a>devbox <i>online</i></a><a>laptop <i>local</i></a></aside>
    <div class="workspace">
      <header><div><p class="eyebrow">${state.location}</p><h1>${state.project}</h1></div><button>Open in Claude Code</button></header>
      <div class="metrics"><article><small>HOST</small><strong>Healthy</strong><span>v0.1.4 · SSH</span></article><article><small>PINNED HARNESS</small><strong>sandcastle</strong><span>8fe1c4a · clean</span></article><article><small>ACTIVE RUN</small><strong>Approval needed</strong><span>prepared 2m ago</span></article></div>
      <div class="split"><article class="runs"><h2>Harness runs</h2><div class="run selected"><span class="pulse"></span><div><b>Define recovery contract</b><p>${state.run} · launch prepared</p></div><em>Review →</em></div><div class="run"><span class="done">✓</span><div><b>Define persistent state</b><p>completed · 42m · 3 commits</p></div><em>Result →</em></div><div class="run"><span class="done">✓</span><div><b>Research credential portability</b><p>completed · 18m · documentation</p></div><em>Result →</em></div></article>
      <article class="approval"><p class="eyebrow">LAUNCH REQUEST</p><h2>Define recovery contract</h2><p>The Host will start the pinned Harness against the first eligible backlog item.</p><ul><li>Durable after disconnect</li><li>Observable by another Controller</li><li>Cancellation retained by Host</li></ul><div class="warning">GitHub and Project write access requested</div><button class="launch">Approve launch</button><button class="quiet full">Inspect request</button></article></div>
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
