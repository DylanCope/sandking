// PROTOTYPE — three Cockpit UI-foundation variants, switchable via ?variant=.
const variants = [
  { key: "A", name: "Workbench", render: renderWorkbench },
  { key: "B", name: "Focus mode", render: renderFocus },
  { key: "C", name: "Command centre", render: renderCommand },
];

const state = {
  project: "sandking",
  path: "/home/dylan/projects/token-maxxing",
  host: "Dylan-G16 · local",
  session: "Slice 1 acceptance",
  provider: "Claude Code 2.1.220",
  run: "run-01K1FA4Q",
  issue: "#126 Accept slice 1",
};

const icon = (symbol) => `<span class="icon" aria-hidden="true">${symbol}</span>`;
const status = (kind, text) => `<span class="badge"><i class="dot ${kind}"></i>${text}</span>`;

function terminal(extraClass = "") {
  return `<section class="terminal ${extraClass}">
    <div class="terminal-head"><span class="traffic"><i></i><i></i><i></i></span><b>${state.provider}</b><span>· ${state.session}</span><span class="right"><i class="dot live"></i>read-write · 100 × 30</span></div>
    <div class="terminal-screen">
      <div class="dim">╭─── Claude Code v2.1.220 ─────────────────────────────────────────╮</div>
      <div class="dim">│</div>
      <div>  Welcome back, Dylan. <span class="green">Sand-King Controller connected.</span></div>
      <div class="dim">│</div>
      <div>  Selected Project  <span class="purple">${state.project}</span></div>
      <div>  Work context      ${state.issue}</div>
      <div>  Harness           sandcastle @ 0b24712</div>
      <div class="dim">│</div>
      <div>  I inspected the selected work context. A Launch request is ready</div>
      <div>  for the conformance Harness and requires your explicit approval.</div>
      <div class="dim">╰──────────────────────────────────────────────────────────────────╯</div>
      <div class="prompt"><span class="purple">❯</span> Review the launch request before I approve it.<span class="cursor"></span></div>
    </div>
    <div class="terminal-foot"><span>esc interrupt · ctrl+r history</span><span>provider PTY · browser attached</span></div>
  </section>`;
}

function globalNav(active = "Projects") {
  return `<aside class="global-nav">
    <div class="brand">SAND<mark>—</mark>KING</div>
    ${[["⌂","Home"],["◇","Projects"],["⬡","Harnesses"],["⌁","Hosts"]].map(([i,label]) => `<a class="nav-link ${label === active ? "active" : ""}">${icon(i)}${label}${label === "Projects" ? '<span class="count">2</span>' : ""}</a>`).join("")}
    <div class="nav-group">RECENT PROJECTS</div>
    <a class="nav-link active">${icon("◆")}sandking <i class="dot live"></i></a>
    <a class="nav-link">${icon("◇")}anki-ai-cards</a>
    <div class="nav-group">WORK CONTEXTS</div>
    <a class="nav-link active">${icon("›")}Slice 1 acceptance</a>
    <a class="nav-link">${icon("·")}General Project</a>
    <a class="nav-link">${icon("·")}Cockpit UI prototype</a>
    <div class="nav-footer"><a class="nav-link">${icon("⚙")}Settings</a><a class="nav-link"><span class="avatar">DC</span><span>Dylan</span></a></div>
  </aside>`;
}

function projectTopbar() {
  return `<header class="topbar"><div class="breadcrumbs"><span>Projects</span><span>/</span><b>${state.project}</b><span>/</span><span>${state.session}</span></div>${status("live", "Host connected")}<div class="top-actions"><button class="button ghost">Open in Claude Code ↗</button><button class="button">New session</button></div></header>`;
}

function contextRail() {
  return `<aside class="workbench-context">
    <div class="context-header"><div><span class="eyebrow">Current work context</span><h2>${state.session}</h2></div></div>
    <section class="context-section"><span class="badge purple">Project · focused</span><dl class="definition"><dt>Project</dt><dd>${state.project}</dd><dt>Issue</dt><dd>${state.issue} ↗</dd><dt>Provider</dt><dd>Claude Code</dd><dt>Attachment</dt><dd>Read-write</dd></dl></section>
    <section class="context-section approval"><span class="eyebrow">Person required</span><h2>Approve Launch request</h2><p class="muted tiny">One ready issue through the pinned Harness. The run survives Controller disconnection.</p><div class="approval-actions"><button class="button primary">Review in Controller</button><button class="button ghost">Details</button></div></section>
    <section class="context-section"><span class="eyebrow">Planning journey</span><div class="journey-rail">
      <div class="journey-step done"><span class="number">✓</span><span>Wayfinding<small>Map resolved</small></span></div>
      <div class="journey-step done"><span class="number">✓</span><span>Speccing<small>Specification #116</small></span></div>
      <div class="journey-step done"><span class="number">✓</span><span>Ticketing<small>Slice #125</small></span></div>
      <div class="journey-step active"><span class="number">4</span><span>Execute<small>Final acceptance</small></span></div>
    </div></section>
    <section class="context-section"><span class="eyebrow">Active Harness run</span><div class="mini-run"><b>${state.run}</b>${status("warn","Review")}<small>Issue #126 · 7 events · 12m</small></div></section>
  </aside>`;
}

function runSummary(includeFailure = false) {
  return `<div class="card card-pad"><div style="display:flex;justify-content:space-between"><div><span class="eyebrow">Harness run</span><h2>${state.run}</h2></div>${status(includeFailure ? "fail" : "warn", includeFailure ? "Failed safely" : "Reviewing")}</div>
    <div class="run-line"><span class="green">✓</span><div><b>Worker delivered issue #124</b><div class="tiny muted">PR #143 merged into main</div></div><span class="tiny muted">18m</span></div>
    <div class="run-line"><span class="green">✓</span><div><b>Independent review accepted</b><div class="tiny muted">All blocking findings resolved</div></div><span class="tiny muted">4m</span></div>
    <div class="run-line"><span class="dot ${includeFailure ? "fail" : "warn"}"></span><div><b>${includeFailure ? "Provider session rendering failed" : "Human acceptance required"}</b><div class="tiny muted">${includeFailure ? "Canonical state preserved; retry available" : "Continue through the focused Controller"}</div></div><span class="tiny muted">now</span></div>
    ${includeFailure ? '<div class="failure"><b>controller_terminal_rendering_unsupported</b><br><span class="tiny">The provider PTY is connected, but its interactive screen cannot be rendered safely.</span></div>' : ""}
  </div>`;
}

function renderWorkbench() {
  return `<div class="workbench-shell">${globalNav()}<main class="workbench-main">${projectTopbar()}<div class="workbench-stage"><div class="stage-title"><div><span class="eyebrow">Focused Controller</span><h1>${state.session}</h1></div><nav class="project-tabs tabs"><button class="tab active">Controller</button><button class="tab">Planning</button><button class="tab">Runs <span class="badge purple">1</span></button><button class="tab">Project</button></nav></div>${terminal()}<div class="attention-list"><div class="attention"><span class="dot warn"></span><div><b>Launch approval is waiting in this Controller session</b><p>Inspect the immutable preview before approving.</p></div><button class="button primary">Focus terminal</button></div></div></div></main>${contextRail()}</div>`;
}

function renderFocus() {
  return `<div class="focus-shell"><header class="focus-header"><div class="brand">S<mark>—</mark>K</div><button class="button ghost">☰</button><div class="scope"><b>${state.project}</b><span class="muted">/</span><span>${state.session}</span></div>${status("live","Connected")}<div class="top-actions"><button class="button ghost">Open externally ↗</button><button class="button">Exit focus</button></div></header>${terminal("focus-terminal")}<section class="focus-dock"><nav class="dock-tabs"><button class="dock-tab active">Context</button><button class="dock-tab">Journey</button><button class="dock-tab">Run</button><button class="dock-tab">Diagnostics</button><span style="margin-left:auto" class="tiny muted">⌘J toggle drawer</span></nav><div class="dock-content"><div class="dock-pane"><span class="eyebrow">Current context</span><h2>${state.issue}</h2><div class="compact-rail"><span class="compact-step">Wayfind ✓</span><span class="compact-step">Specify ✓</span><span class="compact-step">Ticket ✓</span><span class="compact-step active">Execute</span></div></div><div class="dock-pane approval"><span class="eyebrow">Approval pending</span><h2>Launch conformance Harness</h2><button class="button primary">Review in terminal</button></div><div class="dock-pane"><span class="eyebrow">Run activity</span><h2>${state.run}</h2><p class="tiny muted"><i class="dot warn"></i>Awaiting explicit approval · 7 events</p></div></div></section></div>`;
}

function renderCommand() {
  return `<div class="command-shell"><aside class="icon-nav"><div class="brand">S<mark>—</mark>K</div><button class="icon-button">⌂</button><button class="icon-button active">◇</button><button class="icon-button">⬡</button><button class="icon-button">⌁</button><div class="avatar">DC</div></aside><main class="command-main"><header class="command-header"><h1>${state.project}</h1>${status("live",state.host)}<div class="top-actions"><button class="button ghost">${state.path}</button><button class="button">New session</button></div></header><nav class="workspace-tabs"><button class="workspace-tab active">Controller workspace</button><button class="workspace-tab">Planning journey</button><button class="workspace-tab">Harness runs <span class="badge purple">1</span></button><button class="workspace-tab">Project details</button></nav><div class="command-grid"><div>${terminal()}</div><aside class="command-side"><div class="command-overview"><div class="card metric"><span class="eyebrow">Sessions</span><strong>3</strong><small>1 focused</small></div><div class="card metric"><span class="eyebrow">Runs</span><strong>1</strong><small>reviewing</small></div><div class="card metric"><span class="eyebrow">Issues</span><strong>2</strong><small>open</small></div></div><div class="card card-pad approval"><span class="eyebrow">Next action</span><h2>Review Launch request</h2><p class="tiny muted">Approval remains inside the focused Controller conversation.</p><button class="button primary">Focus Controller</button></div>${runSummary(true)}</aside></div></main></div>`;
}

function currentVariant() { const key = new URLSearchParams(location.search).get("variant")?.toUpperCase(); return variants.find((variant) => variant.key === key) ?? variants[0]; }
function show(key) { const url = new URL(location.href); url.searchParams.set("variant", key); history.replaceState({}, "", url); render(); }
function cycle(offset) { const index = variants.findIndex((variant) => variant.key === currentVariant().key); show(variants[(index + offset + variants.length) % variants.length].key); }
function render() { const variant = currentVariant(); document.querySelector("#app").innerHTML = variant.render(); document.querySelector("#variant-label").textContent = `${variant.key} — ${variant.name}`; }
document.querySelector("#previous").addEventListener("click", () => cycle(-1));
document.querySelector("#next").addEventListener("click", () => cycle(1));
document.addEventListener("keydown", (event) => { if (["INPUT","TEXTAREA"].includes(event.target.tagName) || event.target.isContentEditable) return; if (event.key === "ArrowLeft") cycle(-1); if (event.key === "ArrowRight") cycle(1); });
render();
