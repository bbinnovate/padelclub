const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const VIEW_ROOT = path.join(ROOT, "view");
const PORT = Number(process.env.PORT || 8080);
const FIREBASE_AUTH_BASE_URL = "https://identitytoolkit.googleapis.com/v1";
const FIRESTORE_DATABASE = "(default)";

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

function getEnv() {
  return { ...loadEnv(), ...process.env };
}

function sendJson(response, status, payload) {
  send(response, status, JSON.stringify(payload, null, 2), "application/json; charset=utf-8");
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    request.on("error", reject);
  });
}

async function firebaseRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Firebase request failed with status ${response.status}.`);
  return data;
}

async function createOrSignInFirebaseUser(env, { email, password }) {
  try {
    return await firebaseRequest(`${FIREBASE_AUTH_BASE_URL}/accounts:signUp?key=${env.FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
  } catch (error) {
    if (!String(error.message || "").includes("EMAIL_EXISTS")) throw error;
    return firebaseRequest(`${FIREBASE_AUTH_BASE_URL}/accounts:signInWithPassword?key=${env.FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
  }
}

function toFirestoreValue(value) {
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (value && typeof value === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toFirestoreValue(item)])) } };
  }
  return { stringValue: value == null ? "" : String(value) };
}

function toFirestoreDocument(data) {
  return { fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toFirestoreValue(value)])) };
}

async function handleRegisterAdmin(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed. Use POST." });
    return;
  }

  const env = getEnv();
  try {
    const body = await readJsonBody(request);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name || !email || password.length < 6) {
      sendJson(response, 400, { ok: false, error: "name, email, and password(min 6 chars) are required." });
      return;
    }
    if (!env.FIREBASE_API_KEY || !env.FIREBASE_PROJECT_ID) throw new Error("Firebase env is not configured.");

    const authUser = await createOrSignInFirebaseUser(env, { email, password });
    const profile = {
      uid: authUser.localId,
      name,
      email: authUser.email || email,
      phoneNumber: "",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await firebaseRequest(
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/${FIRESTORE_DATABASE}/documents/Users/${profile.uid}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authUser.idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(toFirestoreDocument(profile)),
      },
    );

    sendJson(response, 201, {
      ok: true,
      message: "Admin account created.",
      user: { uid: profile.uid, name: profile.name, email: profile.email, role: profile.role },
    });
  } catch (error) {
    const message = error.message || "Could not create admin account.";
    sendJson(response, message.includes("EMAIL_EXISTS") ? 409 : 500, { ok: false, error: message });
  }
}

function sendRuntimeConfig(response) {
  const env = getEnv();
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
  const publicConfig = {
    baseUrl: (env.PUBLIC_BASE_URL || env.CONFIRMATION_BASE_URL || "").replace(/\/+$/, ""),
  };

  send(
    response,
    200,
    [
      `window.PADEL_FIREBASE_CONFIG = ${JSON.stringify(firebaseConfig)};`,
      `window.PADEL_MESSAGE_CONFIG = ${JSON.stringify(messageConfig)};`,
      `window.PADEL_PUBLIC_CONFIG = ${JSON.stringify(publicConfig)};`,
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

  if (routePath === "/api/register-admin") {
    handleRegisterAdmin(request, response);
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
        : routePath === "/admin-staff"
          ? path.join("view", "admin-staff.html")
        : routePath === "/booking"
          ? path.join("view", "booking.html")
          : routePath === "/booking-confirm"
            ? path.join("view", "booking-confirm.html")
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
            : routePath === "/admin-staff"
              ? "admin-staff.html"
            : routePath === "/booking"
              ? "booking.html"
              : routePath === "/booking-confirm"
                ? "booking-confirm.html"
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
  console.log(`Jain Gymkhana running at http://127.0.0.1:${PORT}`);
});
