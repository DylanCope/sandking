import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const types = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript" };
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const file = join(root, path === "/" ? "index.html" : path.slice(1));
  response.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
  createReadStream(file).on("error", () => {
    response.statusCode = 404;
    response.end("Not found");
  }).pipe(response);
});

server.listen(4173, "127.0.0.1", () => {
  console.log("PROTOTYPE — Cockpit UI foundation: http://127.0.0.1:4173/?variant=A");
});
