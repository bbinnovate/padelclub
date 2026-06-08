const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const VIEW_ROOT = path.join(ROOT, "view");
const PORT = Number(process.env.PORT || 8080);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return {};

  return fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .reduce((env, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return env;

      const separatorIndex = trimmed.indexOf("=");
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key) env[key] = value;
      return env;
    }, {});
}

function send(response, status, content, type = "text/plain; charset=utf-8", headers = {}) {
  response.writeHead(status, { "Content-Type": type, ...headers });
  response.end(content);
}

function sendRuntimeConfig(response) {
  const env = loadEnv();
  const firebaseConfig = {
    apiKey: env.FIREBASE_API_KEY || "",
    authDomain: env.FIREBASE_AUTH_DOMAIN || "",
    projectId: env.FIREBASE_PROJECT_ID || "",
    storageBucket: env.FIREBASE_STORAGE_BUCKET || "",
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || "",
    appId: env.FIREBASE_APP_ID || "",
    measurementId: env.FIREBASE_MEASUREMENT_ID || "",
  };
  const messageConfig = {
    smsEndpoint: env.SMS_CONFIRMATION_ENDPOINT || "",
    whatsAppEndpoint: env.WHATSAPP_CONFIRMATION_ENDPOINT || "",
    senderNumber: env.MESSAGE_SENDER_NUMBER || "",
  };

  send(
    response,
    200,
    [
      `window.PADEL_FIREBASE_CONFIG = ${JSON.stringify(firebaseConfig)};`,
      `window.PADEL_MESSAGE_CONFIG = ${JSON.stringify(messageConfig)};`,
    ].join("\n"),
    "application/javascript; charset=utf-8",
    { "Cache-Control": "no-store" },
  );
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const requestPath = decodeURIComponent(url.pathname);
  const routePath = requestPath.replace(/\/$/, "") || "/";

  if (routePath === "/config.js" || routePath === "/api/config.js") {
    sendRuntimeConfig(response);
    return;
  }

  if (requestPath.split("/").some((part) => part.startsWith("."))) {
    send(response, 404, "Not found");
    return;
  }

  if (path.extname(routePath) === ".html") {
    send(response, 404, "Not found");
    return;
  }

  const relativePath =
    routePath === "/"
      ? path.join("view", "index.html")
      : routePath === "/admin-layout"
        ? path.join("view", "admin-layout.html")
      : routePath === "/admin"
        ? path.join("view", "admin.html")
        : routePath === "/booking"
          ? path.join("view", "booking.html")
          : routePath === "/login"
            ? path.join("view", "login.html")
            : requestPath.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relativePath);

  if (!filePath.startsWith(ROOT)) {
    send(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (!path.extname(requestPath)) {
        const viewFile =
          routePath === "/admin"
            ? "admin.html"
            : routePath === "/admin-layout"
              ? "admin-layout.html"
            : routePath === "/booking"
              ? "booking.html"
              : routePath === "/login"
                ? "login.html"
                : "index.html";
        fs.readFile(path.join(VIEW_ROOT, viewFile), (indexError, indexContent) => {
          if (indexError) {
            send(response, 404, "Not found");
            return;
          }

          send(response, 200, indexContent, MIME_TYPES[".html"]);
        });
        return;
      }

      send(response, 404, "Not found");
      return;
    }

    send(response, 200, content, MIME_TYPES[path.extname(filePath)] || "application/octet-stream");
  });
}

http.createServer(serveStatic).listen(PORT, "127.0.0.1", () => {
  console.log(`Padel Club running at http://127.0.0.1:${PORT}`);
});
