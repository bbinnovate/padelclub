const {
  createAccessToken,
  getAccessGateSettings,
  isAccessGateEnabled,
  makeAccessCookie,
  safeEqual,
} = require("../lib/access-gate");

const attempts = new Map();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function sendJson(response, status, payload, headers = {}) {
  response.statusCode = status;
  Object.entries({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  }).forEach(([name, value]) => response.setHeader(name, value));
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4096) {
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

function getClientKey(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket?.remoteAddress || "unknown";
}

function getAttemptState(key, now = Date.now()) {
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
    attempts.set(key, fresh);
    return fresh;
  }
  return current;
}

module.exports = async function accessLogin(request, response, envOverride) {
  const env = envOverride || process.env;
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." }, { Allow: "POST" });
    return;
  }

  if (!isAccessGateEnabled(env)) {
    sendJson(response, 200, { ok: true });
    return;
  }

  const clientKey = getClientKey(request);
  const attempt = getAttemptState(clientKey);
  if (attempt.count >= MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((attempt.resetAt - Date.now()) / 1000));
    sendJson(response, 429, { ok: false, error: "Too many attempts. Please try again later." }, { "Retry-After": String(retryAfter) });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const { password } = getAccessGateSettings(env);
    if (!safeEqual(String(body.password || ""), password)) {
      attempt.count += 1;
      sendJson(response, 401, { ok: false, error: "Incorrect password." });
      return;
    }

    attempts.delete(clientKey);
    const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const secure = forwardedProto === "https" || Boolean(request.socket?.encrypted);
    const token = createAccessToken(env);
    sendJson(response, 200, { ok: true }, { "Set-Cookie": makeAccessCookie(token, env, { secure }) });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message || "Could not verify password." });
  }
};
