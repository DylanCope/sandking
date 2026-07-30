import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

createServer((request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const file = join(root, pathname === "/" ? "index.html" : pathname);
  response.setHeader("content-type", types[extname(file)] ?? "text/plain");
  createReadStream(file).on("error", () => { response.statusCode = 404; response.end("Not found"); }).pipe(response);
}).listen(4174, "127.0.0.1", () => console.log("Prototype: http://127.0.0.1:4174/?variant=A"));
