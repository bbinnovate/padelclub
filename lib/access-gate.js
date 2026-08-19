const crypto = require("crypto");

const ACCESS_COOKIE_NAME = "jg_frontend_access";
const DEFAULT_PASSWORD = "cswp8";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

function isAccessGateEnabled(env = process.env) {
  return String(env.FRONTEND_GATE_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

function getAccessGateSettings(env = process.env) {
  const password = String(env.FRONTEND_ACCESS_PASSWORD || DEFAULT_PASSWORD);
  const secret = String(env.FRONTEND_ACCESS_SECRET || password);
  const configuredTtl = Number(env.FRONTEND_ACCESS_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  const ttlSeconds = Number.isFinite(configuredTtl) && configuredTtl > 0 ? Math.floor(configuredTtl) : DEFAULT_TTL_SECONDS;
  return { password, secret, ttlSeconds };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signExpiry(expiresAt, secret) {
  return crypto.createHmac("sha256", secret).update(String(expiresAt)).digest("base64url");
}

function createAccessToken(env = process.env, now = Date.now()) {
  const { secret, ttlSeconds } = getAccessGateSettings(env);
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  return `${expiresAt}.${signExpiry(expiresAt, secret)}`;
}

function verifyAccessToken(token, env = process.env, now = Date.now()) {
  const [expiresRaw, signature, extra] = String(token || "").split(".");
  if (!expiresRaw || !signature || extra) return false;
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;
  const { secret } = getAccessGateSettings(env);
  return safeEqual(signature, signExpiry(expiresAt, secret));
}

function parseCookies(cookieHeader = "") {
  return String(cookieHeader)
    .split(";")
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return cookies;
      const key = part.slice(0, separator).trim();
      if (!key) return cookies;
      cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
      return cookies;
    }, {});
}

function hasValidAccessCookie(request, env = process.env) {
  const cookies = parseCookies(request.headers.cookie || "");
  return verifyAccessToken(cookies[ACCESS_COOKIE_NAME], env);
}

function makeAccessCookie(token, env = process.env, { secure = false } = {}) {
  const { ttlSeconds } = getAccessGateSettings(env);
  return [
    `${ACCESS_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${ttlSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

module.exports = {
  ACCESS_COOKIE_NAME,
  createAccessToken,
  getAccessGateSettings,
  hasValidAccessCookie,
  isAccessGateEnabled,
  makeAccessCookie,
  safeEqual,
  verifyAccessToken,
};
