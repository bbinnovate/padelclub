import { next } from "@vercel/functions";

const COOKIE_NAME = "jg_frontend_access";
const encoder = new TextEncoder();

function gateEnabled() {
  return String(process.env.FRONTEND_GATE_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

function parseCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return "";
}

function toBase64Url(buffer) {
  let binary = "";
  new Uint8Array(buffer).forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function expectedSignature(expiresAt) {
  const password = String(process.env.FRONTEND_ACCESS_PASSWORD || "cswp8");
  const secret = String(process.env.FRONTEND_ACCESS_SECRET || password);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(String(expiresAt))));
}

async function validToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return false;
  const expiresAt = Number(parts[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const expected = await expectedSignature(expiresAt);
  if (expected.length !== parts[1].length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ parts[1].charCodeAt(index);
  }
  return difference === 0;
}

export const config = {
  matcher: "/(.*)",
};

export default async function accessGate(request) {
  if (!gateEnabled()) return next();

  const url = new URL(request.url);
  const publicPath = url.pathname === "/access" || url.pathname === "/access.html" || url.pathname === "/api/access-login";
  if (publicPath) return next();

  const token = parseCookie(request.headers.get("cookie"), COOKIE_NAME);
  if (await validToken(token)) return next();

  const accessUrl = new URL("/access", url);
  accessUrl.searchParams.set("returnTo", url.pathname + url.search);
  return Response.redirect(accessUrl, 307);
}
