const FIREBASE_AUTH_BASE_URL = "https://identitytoolkit.googleapis.com/v1";
const FIRESTORE_DATABASE = "(default)";

async function firebaseRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Firebase request failed with status ${response.status}.`);
  return data;
}

async function createOrSignInFirebaseUser({ email, password }) {
  try {
    return await firebaseRequest(`${FIREBASE_AUTH_BASE_URL}/accounts:signUp?key=${process.env.FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
  } catch (error) {
    if (!String(error.message || "").includes("EMAIL_EXISTS")) throw error;
    return firebaseRequest(`${FIREBASE_AUTH_BASE_URL}/accounts:signInWithPassword?key=${process.env.FIREBASE_API_KEY}`, {
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

module.exports = async function registerAdmin(request, response) {
  if (request.method !== "POST") {
    response.status(405).json({ ok: false, error: "Method not allowed. Use POST." });
    return;
  }

  try {
    const body = request.body || {};
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name || !email || password.length < 6) {
      response.status(400).json({ ok: false, error: "name, email, and password(min 6 chars) are required." });
      return;
    }
    if (!process.env.FIREBASE_API_KEY || !process.env.FIREBASE_PROJECT_ID) throw new Error("Firebase env is not configured.");

    const authUser = await createOrSignInFirebaseUser({ email, password });
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
      `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/${FIRESTORE_DATABASE}/documents/Users/${profile.uid}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${authUser.idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(toFirestoreDocument(profile)),
      },
    );

    response.status(201).json({
      ok: true,
      message: "Admin account created.",
      user: { uid: profile.uid, name: profile.name, email: profile.email, role: profile.role },
    });
  } catch (error) {
    const message = error.message || "Could not create admin account.";
    response.status(message.includes("EMAIL_EXISTS") ? 409 : 500).json({ ok: false, error: message });
  }
};
