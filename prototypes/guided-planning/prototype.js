// PROTOTYPE — three variants of the optional planning journey, switchable via ?variant=.
const variants = [
  { key: "A", name: "Conversation first", render: conversation },
  { key: "B", name: "Journey rail", render: journey },
  { key: "C", name: "Artifact workbench", render: workbench },
];

const steps = `<div class="steps"><span class="done">✓ Idea</span><span class="active">2 Wayfind</span><span>3 Specify</span><span>4 Ticket</span><span>5 Execute</span></div>`;
const side = `<aside><b class="logo">SAND—KING</b><a>⌂ Home</a><a class="on">◇ token-maxxing</a><a>⌁ Harnesses</a><hr><small>WORK CONTEXTS</small><a class="context">Chart the token strategy <i>live</i></a><a>General Project conversation</a><button>＋ New Controller session</button></aside>`;

function shell(content) { return `<div class="shell">${side}<section class="main">${content}</section></div>`; }
function header(kicker, title) { return `<header><div><small>${kicker}</small><h1>${title}</h1></div><span class="host">● devbox · connected</span></header>`; }

function conversation() {
  return shell(`${header("PROJECT · TOKEN-MAXXING", "What do you want to move forward?")}
    <div class="conversation"><div class="chat">
      <p class="person">I want a better way to budget agents across long projects.</p>
      <article><b>Controller</b><p>That sounds larger than one session. I can help you explore it directly, or start a guided planning journey.</p><div class="choice"><button class="primary">Start with Wayfinding</button><button>Keep talking</button></div><small>Optional: Wayfinding → Speccing → Ticketing → Harness execution</small></article>
      <article><b>Controller</b><p>I opened the focused work context <u>Chart the token strategy</u>. Its map and decision tickets are canonical on GitHub.</p>${steps}<div class="question"><small>CURRENT DECISION</small><b>What outcome should the first release optimize?</b><p>Answer here, or open the canonical ticket ↗</p></div></article>
    </div><div class="composer">Reply to the Controller… <b>↵</b></div></div>`);
}

function journey() {
  return shell(`${header("PLANNING JOURNEY", "Chart the token strategy")}${steps}
    <div class="journey"><nav><small>THIS JOURNEY</small><a class="selected"><b>Wayfinding</b><span>1 decision ready</span></a><a><b>Speccing</b><span>Available after the route is clear</span></a><a><b>Ticketing</b><span>Not started</span></a><a><b>Harness execution</b><span>Not started</span></a><hr><button>Skip ahead or leave journey</button></nav>
    <section class="focus"><div class="focus-head"><div><small>WAYFINDER EFFORT</small><h2>Find the route to an implementation-ready decision</h2></div><a>Open map on GitHub ↗</a></div>
      <div class="notice">The journey is guidance, not a gate. You can create an ordinary issue or start a Harness run from the Project conversation at any time.</div>
      <h3>Ready now</h3><article class="ticket"><span class="dot"></span><div><b>Choose the budgeting objective</b><p>Grilling · unclaimed · canonical GitHub issue</p></div><button class="primary">Start focused session</button></article>
      <h3>What follows</h3><div class="next"><article><small>WHEN THE MAP IS CLEAR</small><b>Shape a Specification</b><p>Review a private revision before publishing downstream.</p></article><article><small>WHEN APPROVED</small><b>Publish executable tickets</b><p>Review dependencies and execution eligibility on GitHub.</p></article></div>
    </section></div>`);
}

function workbench() {
  return shell(`${header("WORK CONTEXT · DECISION TICKET", "Choose the budgeting objective")}
    <div class="workbench"><section class="terminal"><div class="bar">Claude Code · focused Controller session <span>● active</span></div><div class="terminal-body"><p>❯ Start this decision.</p><p><b>Claude</b> I claimed <u>Choose the budgeting objective</u> on GitHub.</p><p><b>Claude</b> Should the first release maximize completed useful work, minimize wasted tokens, or make the trade-off visible without choosing for the person?</p><p class="typing">❯ Make the trade-off visible; don’t optimize it for me.<i></i></p></div></section>
    <aside class="artifact"><small>CANONICAL ARTIFACT</small><h2>Choose the budgeting objective</h2><span class="badge">Wayfinding · claimed</span><dl><dt>Part of</dt><dd>Chart the token strategy ↗</dd><dt>Stored in</dt><dd>GitHub Issue</dd><dt>Session scope</dt><dd>This decision only</dd></dl><hr><small>AFTER RESOLUTION</small><p>Return to the journey and choose whether to begin Speccing.</p><button class="primary">Open on GitHub ↗</button></aside></div>
    <footer><span>Journey: <b>Wayfinding</b> → Speccing → Ticketing → Execute</span><button>Leave focused context</button></footer>`);
}

function current() { const key = new URLSearchParams(location.search).get("variant")?.toUpperCase(); return variants.find(v => v.key === key) ?? variants[0]; }
function show(key) { const url = new URL(location.href); url.searchParams.set("variant", key); history.replaceState({}, "", url); render(); }
function cycle(offset) { const i = variants.indexOf(current()); show(variants[(i + offset + variants.length) % variants.length].key); }
function render() { const v = current(); document.querySelector("#app").innerHTML = v.render(); document.querySelector("#variant-label").textContent = `${v.key} — ${v.name}`; }
document.querySelector("#previous").onclick = () => cycle(-1); document.querySelector("#next").onclick = () => cycle(1);
document.addEventListener("keydown", e => { if (["INPUT", "TEXTAREA"].includes(e.target.tagName) || e.target.isContentEditable) return; if (e.key === "ArrowLeft") cycle(-1); if (e.key === "ArrowRight") cycle(1); });
render();
