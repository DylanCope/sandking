import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** @param {string} relativePath */
const sourcePath = (relativePath) => fileURLToPath(new URL(relativePath, import.meta.url));

const cockpitModules = [
  "dom.mjs",
  "socket.mjs",
  "terminal.mjs",
  "project-preparation.mjs",
  "harness-run.mjs",
  "chrome.mjs",
];

const cockpitHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sand-King Cockpit</title>
    <link rel="stylesheet" href="/terminal/xterm.css">
    <link rel="stylesheet" href="/cockpit.css">
  </head>
  <body>
    <div id="app">Connecting to local Host…</div>
    <button id="reload-cockpit" type="button" hidden>Reload Cockpit</button>
    <script type="module" src="/cockpit.js"></script>
  </body>
</html>`;

/** Load the bounded, package-local assets exposed by the Controller runtime. */
export const loadHttpAssets = async () => {
  /** @type {Array<[string, {contentType: string, body: string | Uint8Array}]>} */
  const definitions = [
    ["/", { contentType: "text/html; charset=utf-8", body: cockpitHtml }],
    ["/cockpit.js", {
      contentType: "text/javascript; charset=utf-8",
      body: await readFile(sourcePath("../../cockpit/index.mjs"), "utf8"),
    }],
    ["/cockpit-launch-parameters.mjs", {
      contentType: "text/javascript; charset=utf-8",
      body: await readFile(sourcePath("../../cockpit-launch-parameters.mjs"), "utf8"),
    }],
    ["/cockpit-project-registration.mjs", {
      contentType: "text/javascript; charset=utf-8",
      body: await readFile(sourcePath("../../cockpit-project-registration.mjs"), "utf8"),
    }],
    ["/common/identifiers.mjs", {
      contentType: "text/javascript; charset=utf-8",
      body: await readFile(sourcePath("../../common/identifiers.mjs"), "utf8"),
    }],
    ["/cockpit.css", {
      contentType: "text/css; charset=utf-8",
      body: await readFile(sourcePath("../../cockpit.css"), "utf8"),
    }],
    ["/terminal/xterm.mjs", {
      contentType: "text/javascript; charset=utf-8",
      body: await readFile(fileURLToPath(import.meta.resolve("@xterm/xterm/lib/xterm.mjs")), "utf8"),
    }],
    ["/terminal/addon-fit.mjs", {
      contentType: "text/javascript; charset=utf-8",
      body: await readFile(fileURLToPath(import.meta.resolve("@xterm/addon-fit/lib/addon-fit.mjs")), "utf8"),
    }],
    ["/terminal/xterm.css", {
      contentType: "text/css; charset=utf-8",
      body: await readFile(fileURLToPath(import.meta.resolve("@xterm/xterm/css/xterm.css")), "utf8"),
    }],
    ["/terminal/fira-code-regular.woff2", {
      contentType: "font/woff2",
      body: await readFile(fileURLToPath(import.meta.resolve(
        "@fontsource/fira-code/files/fira-code-latin-400-normal.woff2",
      ))),
    }],
    ["/terminal/fira-code-semibold.woff2", {
      contentType: "font/woff2",
      body: await readFile(fileURLToPath(import.meta.resolve(
        "@fontsource/fira-code/files/fira-code-latin-600-normal.woff2",
      ))),
    }],
  ];
  for (const name of cockpitModules) {
    definitions.push([`/cockpit/${name}`, {
      contentType: "text/javascript; charset=utf-8",
      body: await readFile(sourcePath(`../../cockpit/${name}`), "utf8"),
    }]);
  }
  return new Map(definitions);
};
