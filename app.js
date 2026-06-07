// Firebase Integration: initialize Auth and Firestore when the SDK is available.
// If the CDN SDK does not load, the app still uses Firebase REST APIs instead of demo mode.
const firebaseConfig = window.PADEL_FIREBASE_CONFIG || {};
const hasFirebaseConfig =
  Boolean(firebaseConfig.apiKey) &&
  Boolean(firebaseConfig.projectId) &&
  !firebaseConfig.apiKey.startsWith("REPLACE_");
const firebaseSdkReady = Boolean(window.firebase && hasFirebaseConfig);
const firebaseRestReady = hasFirebaseConfig && !firebaseSdkReady;
const firebaseReady = firebaseSdkReady || firebaseRestReady;

let auth = null;
let db = null;
let usersRef = null;
let bookingsRef = null;

if (firebaseSdkReady) {
  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();
  usersRef = db.collection("Users");
  bookingsRef = db.collection("Bookings");
}

const state = {
  selectedSport: "padel",
  selectedDate: 0,
  selectedFacilityId: null,
  selectedSlots: [],
  mode: "player",
  currentUser: null,
  currentProfile: null,
  allBookings: [],
  userBookings: [],
  adminBookingSearch: "",
};

const sports = {
  padel: {
    name: "Padel",
    short: "P",
    unit: "Court",
    count: 2,
    maxSlots: 6,
    pricePerSlot: 1250,
    detail: "Panoramic - Pro turf",
    players: [2, 3, 4],
  },
  pickleball: {
    name: "Pickleball",
    short: "PB",
    unit: "Court",
    count: 4,
    maxSlots: 4,
    pricePerSlot: 800,
    detail: "Competition court",
    players: [2, 3, 4],
  },
  cricket: {
    name: "Turf Cricket",
    short: "TC",
    unit: "Ground",
    count: 3,
    maxSlots: 6,
    pricePerSlot: 1500,
    detail: "Floodlit turf",
    players: [6, 8, 10, 12],
  },
};

const unavailableBySport = {
  padel: {
    1: [4, 5, 13, 14, 26, 27, 28],
    2: [2, 3, 17, 18, 29, 30],
  },
  pickleball: {
    1: [6, 7, 20, 21, 30],
    2: [4, 5, 14, 15, 28, 29],
    3: [10, 11, 22, 23, 32],
    4: [2, 3, 18, 19, 26, 27],
  },
  cricket: {
    1: [8, 9, 10, 11, 24, 25, 26],
    2: [4, 5, 16, 17, 18, 30, 31],
    3: [12, 13, 14, 22, 23, 32, 33],
  },
};

const times = Array.from({ length: 36 }, (_, index) => minutesToTime(360 + index * 30));
const dates = getDates();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const elements = {
  dateScroller: $("#dateScroller"),
  sportOptions: $("#sportOptions"),
  availabilityGrid: $("#availabilityGrid"),
  bookingBar: $("#bookingBar"),
  detailsModal: $("#detailsModal"),
  confirmationModal: $("#confirmationModal"),
  authModal: $("#authModal"),
  bookingForm: $("#bookingForm"),
  authForm: $("#authForm"),
  playerView: $("#playerView"),
  adminView: $("#adminView"),
  userDashboard: $("#userDashboard"),
  slotMessage: $("#slotMessage"),
  alertRegion: $("#alertRegion"),
};

const FIRESTORE_DATABASE = "(default)";
const FIREBASE_AUTH_BASE_URL = "https://identitytoolkit.googleapis.com/v1";
const FIRESTORE_BASE_URL = hasFirebaseConfig
  ? `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${FIRESTORE_DATABASE}/documents`
  : "";

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

function fromFirestoreValue(value) {
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in value) return fromFirestoreFields(value.mapValue.fields || {});
  return undefined;
}

function fromFirestoreFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestoreValue(value)]));
}

function toFirestoreDocument(data) {
  return { fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toFirestoreValue(value)])) };
}

async function firebaseRestRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Firebase request failed with status ${response.status}.`;
    throw new Error(getFirebaseErrorMessage({ code: message, message }));
  }
  return data;
}

async function loginWithFirebaseRest({ email, password }) {
  const login = await firebaseRestRequest(`${FIREBASE_AUTH_BASE_URL}/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  return { uid: login.localId, email: login.email, displayName: login.displayName || email.split("@")[0], idToken: login.idToken };
}

async function setFirestoreRestDocument(collection, docId, data, idToken, merge = false) {
  const queryParams = [];
  if (!idToken && firebaseConfig.apiKey) queryParams.push(`key=${encodeURIComponent(firebaseConfig.apiKey)}`);
  if (merge) Object.keys(data).forEach((key) => queryParams.push(`updateMask.fieldPaths=${encodeURIComponent(key)}`));
  const queryString = queryParams.length ? `?${queryParams.join("&")}` : "";
  const headers = { "Content-Type": "application/json" };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  return firebaseRestRequest(`${FIRESTORE_BASE_URL}/${collection}/${docId}${queryString}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(toFirestoreDocument(data)),
  });
}

async function getFirestoreRestDocument(collection, docId, idToken) {
  const response = await fetch(`${FIRESTORE_BASE_URL}/${collection}/${docId}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Firestore read failed with status ${response.status}.`;
    throw new Error(message.replaceAll("_", " ").toLowerCase());
  }
  return fromFirestoreFields(data.fields || {});
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function minutesToTime(total) {
  total %= 24 * 60;
  const hours24 = Math.floor(total / 60);
  const minutes = total % 60;
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours = hours24 % 12 || 12;
  return `${hours}:${String(minutes).padStart(2, "0")} ${period}`;
}

function getDates() {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + index);
    return date;
  });
}

function getSport() {
  return sports[state.selectedSport];
}

function getFacilities() {
  const sport = getSport();
  return Array.from({ length: sport.count }, (_, index) => ({
    id: index + 1,
    name: `${sport.unit} ${index + 1}`,
    detail: sport.detail,
  }));
}

function getSelection() {
  const sport = getSport();
  const facility = getFacilities().find((item) => item.id === state.selectedFacilityId);
  const slots = [...state.selectedSlots].sort((a, b) => a - b);
  const startIndex = slots[0];
  const durationMinutes = slots.length * 30;
  const endTime = startIndex === undefined ? "" : minutesToTime(360 + (startIndex + slots.length) * 30);

  return {
    sport,
    facility,
    slots,
    date: dates[state.selectedDate],
    startTime: startIndex === undefined ? "" : times[startIndex],
    endTime,
    durationMinutes,
    durationLabel:
      durationMinutes < 60
        ? `${durationMinutes} min`
        : `${durationMinutes / 60} ${durationMinutes === 60 ? "hour" : "hours"}`,
    price: slots.length * sport.pricePerSlot,
  };
}

function toBookingDate(selection) {
  const [time, period] = selection.startTime.split(" ");
  const [hourRaw, minuteRaw] = time.split(":").map(Number);
  let hour = hourRaw % 12;
  if (period === "PM") hour += 12;
  const date = new Date(selection.date);
  date.setHours(hour, minuteRaw, 0, 0);
  return date;
}

function timestampToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  return new Date(value);
}

function formatBookingDate(value) {
  const date = timestampToDate(value);
  if (!date || Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatBookingDateOnly(value) {
  const date = timestampToDate(value);
  if (!date || Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function makeCustomerId(email, phoneNumber) {
  const source = (email || phoneNumber || "guest").trim().toLowerCase();
  const safe = source.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `CUS-${safe || Date.now()}`;
}

function showAlert(message, type = "success") {
  const alert = document.createElement("div");
  alert.className = `app-alert ${type}`;
  alert.textContent = message;
  elements.alertRegion.appendChild(alert);
  setTimeout(() => alert.remove(), 4800);
}

function getFirebaseErrorMessage(error) {
  const code = String(error?.code || error?.message || "").toLowerCase();

  if (code.includes("auth/configuration-not-found") || code.includes("configuration_not_found")) {
    return "Firebase Authentication is not enabled for this project. In Firebase Console, open Build > Authentication > Get started, then enable Email/Password sign-in.";
  }

  if (code.includes("auth/operation-not-allowed") || code.includes("operation_not_allowed")) {
    return "Email/Password sign-in is disabled. Enable it in Firebase Console > Authentication > Sign-in method.";
  }

  if (code.includes("auth/email-already-in-use") || code.includes("email_exists")) {
    return "This email is already registered.";
  }

  if (code.includes("auth/invalid-credential") || code.includes("invalid_password") || code.includes("email_not_found")) {
    return "Invalid email or password.";
  }

  if (code.includes("permission-denied") || code.includes("permission_denied")) {
    return "Firestore rejected the booking write. Deploy the latest firestore.rules and indexes, then hard refresh the app.";
  }

  return error?.message || "Something went wrong. Please try again.";
}

function setButtonLoading(button, loading, label = "Working...") {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.innerHTML;
    button.innerHTML = `<span class="button-spinner"></span>${label}`;
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.originalText || button.innerHTML;
    button.disabled = false;
  }
}

function clearSelection() {
  state.selectedFacilityId = null;
  state.selectedSlots = [];
  elements.bookingBar.hidden = true;
  hideMessage();
}

function renderSports() {
  elements.sportOptions.innerHTML = Object.entries(sports)
    .map(
      ([key, sport]) => `
    <button class="sport-button ${state.selectedSport === key ? "active" : ""}" data-sport="${key}" type="button">
      <span class="sport-icon">${sport.short}</span>
      <span><strong>${sport.name}</strong><small>${sport.count} ${sport.unit.toLowerCase()}${sport.count > 1 ? "s" : ""} - max ${sport.maxSlots / 2} hrs</small></span>
      <b>-></b>
    </button>
  `,
    )
    .join("");

  $$("[data-sport]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSport = button.dataset.sport;
      clearSelection();
      renderSports();
      renderAvailability();
    });
  });
}

function renderDates() {
  elements.dateScroller.innerHTML = dates
    .map((date, index) => {
      const day = index === 0 ? "Today" : date.toLocaleDateString("en-IN", { weekday: "short" });
      const limited = index === 2 || index === 5;
      return `
      <button class="date-button ${limited ? "limited" : ""} ${state.selectedDate === index ? "active" : ""}" data-date="${index}" type="button">
        <small>${day}</small>
        <strong>${String(date.getDate()).padStart(2, "0")}</strong>
        <i></i>
      </button>
    `;
    })
    .join("");

  $$("[data-date]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedDate = Number(button.dataset.date);
      clearSelection();
      renderDates();
      renderAvailability();
    });
  });
}

function isUnavailable(facilityId, slotIndex) {
  const baseUnavailable = unavailableBySport[state.selectedSport][facilityId] || [];
  const dateOffset = state.selectedDate % 3;
  const bookedFromFirestore = state.allBookings.some((booking) => {
    if (booking.status === "Cancelled") return false;
    const date = timestampToDate(booking.bookingDate);
    const selectedDate = dates[state.selectedDate];
    return (
      booking.sportKey === state.selectedSport &&
      Number(booking.facilityId) === facilityId &&
      booking.slotIndexes?.includes(slotIndex) &&
      date?.toDateString() === selectedDate.toDateString()
    );
  });

  return baseUnavailable.includes(slotIndex) || bookedFromFirestore || (dateOffset === 2 && (slotIndex + facilityId) % 17 === 0);
}

function renderAvailability() {
  const sport = getSport();
  const selectedDate = dates[state.selectedDate];
  const facilities = getFacilities();
  $("#availabilityTitle").textContent = `${sport.name} - ${selectedDate.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "2-digit",
    month: "short",
  })}`;
  $("#maxDurationLabel").textContent = `1-${sport.maxSlots / 2} hours`;

  elements.availabilityGrid.style.setProperty("--facility-count", facilities.length);
  elements.availabilityGrid.innerHTML = `
    <div class="availability-corner"><span>Time</span><small>30 min slots</small></div>
    ${facilities
      .map(
        (facility) => `
      <div class="facility-heading"><span>${sport.short}${facility.id}</span><strong>${facility.name}</strong><small>${facility.detail}</small></div>
    `,
      )
      .join("")}
    ${times
      .map(
        (time, slotIndex) => `
      <div class="time-label"><strong>${time}</strong><small>${minutesToTime(360 + (slotIndex + 1) * 30)}</small></div>
      ${facilities
        .map((facility) => {
          const unavailable = isUnavailable(facility.id, slotIndex);
          const selected = state.selectedFacilityId === facility.id && state.selectedSlots.includes(slotIndex);
          const edgeStart = selected && slotIndex === Math.min(...state.selectedSlots);
          const edgeEnd = selected && slotIndex === Math.max(...state.selectedSlots);
          return `<button
            class="slot-cell ${unavailable ? "unavailable" : ""} ${selected ? "selected" : ""} ${edgeStart ? "edge-start" : ""} ${edgeEnd ? "edge-end" : ""}"
            ${unavailable ? "disabled" : ""}
            data-facility="${facility.id}"
            data-slot="${slotIndex}"
            type="button"
            aria-label="${facility.name}, ${time} to ${minutesToTime(360 + (slotIndex + 1) * 30)}${unavailable ? ", booked" : ""}">
            <span>${unavailable ? "Booked" : selected ? "Selected" : "Available"}</span>
          </button>`;
        })
        .join("")}
    `,
      )
      .join("")}
  `;

  $$(".slot-cell:not(.unavailable)").forEach((button) => {
    button.addEventListener("click", () => selectSlot(Number(button.dataset.facility), Number(button.dataset.slot)));
  });
}

function selectSlot(facilityId, slotIndex) {
  const sport = getSport();
  const selected = [...state.selectedSlots].sort((a, b) => a - b);

  if (state.selectedFacilityId !== facilityId || selected.length === 0) {
    state.selectedFacilityId = facilityId;
    state.selectedSlots = [slotIndex];
    showMessage("Select one more consecutive slot to reach the 1-hour minimum.", "info");
  } else if (selected.includes(slotIndex)) {
    if (selected.length === 1) {
      clearSelection();
    } else if (slotIndex === selected[0] || slotIndex === selected[selected.length - 1]) {
      state.selectedSlots = selected.filter((value) => value !== slotIndex);
      if (state.selectedSlots.length === 1) showMessage("Select one more consecutive slot to reach the 1-hour minimum.", "info");
      else hideMessage();
    } else {
      state.selectedSlots = [slotIndex];
      showMessage("Selection restarted here. Add consecutive slots before or after it.", "info");
    }
  } else if (slotIndex === selected[0] - 1 || slotIndex === selected[selected.length - 1] + 1) {
    if (selected.length >= sport.maxSlots) {
      showMessage(`${sport.name} bookings can be up to ${sport.maxSlots / 2} hours.`, "error");
    } else {
      state.selectedSlots = [...selected, slotIndex].sort((a, b) => a - b);
      hideMessage();
    }
  } else {
    state.selectedSlots = [slotIndex];
    showMessage("Selection restarted. Choose consecutive 30-minute slots on the same space.", "info");
  }

  updateBookingBar();
  renderAvailability();
}

function showMessage(message, type = "info") {
  elements.slotMessage.textContent = message;
  elements.slotMessage.className = `slot-message ${type}`;
  elements.slotMessage.hidden = false;
}

function hideMessage() {
  elements.slotMessage.hidden = true;
}

function updateBookingBar() {
  if (!state.selectedSlots.length) {
    elements.bookingBar.hidden = true;
    return;
  }
  const selection = getSelection();
  $("#barCourtBadge").textContent = `${selection.sport.short}${selection.facility.id}`;
  $("#barSport").textContent = selection.sport.name;
  $("#barCourt").textContent = selection.facility.name;
  $("#barDate").textContent = selection.date.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
  $("#barTime").textContent = `${selection.startTime} - ${selection.endTime}`;
  $("#barDuration").textContent = selection.durationLabel;
  $("#barPrice").textContent = formatCurrency(selection.price);
  elements.bookingBar.hidden = false;
}

function showDetailsModal() {
  const selection = getSelection();
  if (state.selectedSlots.length < 2) {
    showMessage("Please select at least two consecutive 30-minute slots to make a 1-hour booking.", "error");
    $("#book").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  $("#modalSummary").innerHTML = `
  <div>
  <small>Sport</small>
  <strong style="display:block; margin:0; line-height:1.1;">
    ${selection.sport.name}
  </strong>
  <strong style="display:block; margin:0; line-height:1.1;">
    ${selection.facility.name}
  </strong>
</div>

<div>
  <small>Date & Time</small>
  <strong style="display:block; margin:0; line-height:1.1;">
    ${selection.date.toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
    })}
  </strong>
  <strong style="display:block; margin:0; line-height:1.1;">
    ${selection.startTime} - ${selection.endTime}
  </strong>
</div>

<div>
  <small>Duration</small>
  <strong>${selection.durationLabel}</strong>
</div>
  `;
  $("#playerOptions").innerHTML = selection.sport.players
    .map(
      (players, index) => `
  `,
    )
    .join("");

  elements.bookingForm.elements.name.value = state.currentProfile?.name || state.currentUser?.displayName || "";
  elements.bookingForm.elements.mobile.value = state.currentProfile?.phoneNumber || "";
  elements.bookingForm.elements.email.value = state.currentProfile?.email || state.currentUser?.email || "";
  elements.detailsModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function makeBookingReference() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString().slice(0, 6);
  return `BK${new Date().getFullYear()}${random}`;
}

function makeVerificationCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

// WhatsApp Share Booking: generate the prefilled sharing URL from booking details.
function buildWhatsAppShareUrl(booking) {
  return `https://wa.me/?text=${encodeURIComponent(buildConfirmationMessage(booking))}`;
}

function buildConfirmationMessage(booking) {
  return [
    "Booking Confirmed",
    "",
    `Name: ${booking.name}`,
    `Phone: ${booking.phoneNumber}`,
    `Email: ${booking.email}`,
    `Sport: ${booking.sportName}`,
    `Court: ${booking.courtName || booking.facilityName}`,
    `Date: ${booking.bookingDateLabel || formatBookingDateOnly(booking.bookingDate)}`,
    `Time: ${booking.timeSlot || `${booking.startTime} - ${booking.endTime}`}`,
    `Booking ID: ${booking.bookingId}`,
    `Booking Token: ${booking.bookingToken}`,
  ].join("\n");
}

// Booking Confirmation Messaging: backend endpoints can later send SMS/WhatsApp from 8879961503.
function createMessageServices() {
  const senderNumber = "8879961503";

  return {
    sms: {
      async sendBookingConfirmation(booking) {
        if (!window.PADEL_MESSAGE_CONFIG?.smsEndpoint) {
          return { ok: false, skipped: true, message: "SMS endpoint is not configured." };
        }
        const response = await fetch(window.PADEL_MESSAGE_CONFIG.smsEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: senderNumber,
            to: booking.phoneNumber,
            message: buildConfirmationMessage(booking),
          }),
        });
        return { ok: response.ok };
      },
    },
    whatsapp: {
      async sendBookingConfirmation(booking) {
        if (!window.PADEL_MESSAGE_CONFIG?.whatsAppEndpoint) {
          return { ok: false, skipped: true, message: "WhatsApp endpoint is not configured." };
        }
        const response = await fetch(window.PADEL_MESSAGE_CONFIG.whatsAppEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: senderNumber,
            to: booking.phoneNumber,
            message: buildConfirmationMessage(booking),
          }),
        });
        return { ok: response.ok };
      },
    },
  };
}

const messageServices = createMessageServices();

if (window.PadelMessagingService) {
  messageServices.sms.sendBookingConfirmation = async (booking) => {
    const message = window.PadelMessagingService.buildConfirmationMessage(booking, formatCurrency, formatBookingDate);
    return window.PadelMessagingService.sendSmsConfirmation(booking, message);
  };
  messageServices.whatsapp.sendBookingConfirmation = async (booking) => {
    const message = window.PadelMessagingService.buildConfirmationMessage(booking, formatCurrency, formatBookingDate);
    return window.PadelMessagingService.sendWhatsAppConfirmation(booking, message);
  };
}

// Booking Creation: persist linked user bookings in Firestore with unique IDs and tokens.
async function confirmBooking(formData, submitButton) {
  setButtonLoading(submitButton, true, "Saving...");

  try {
    const selection = getSelection();
    const bookingId = makeBookingReference();
    const bookingToken = makeVerificationCode();
    const players = formData.get("players");
    const bookingDate = toBookingDate(selection);
    const name = formData.get("name").trim();
    const email = formData.get("email").trim();
    const phoneNumber = formData.get("mobile").trim();
    const customerId = makeCustomerId(email, phoneNumber);
    const createdAt = firebaseSdkReady ? firebase.firestore.FieldValue.serverTimestamp() : new Date().toISOString();
    const customer = {
      customerId,
      name,
      email,
      phoneNumber,
      createdAt,
      updatedAt: createdAt,
    };
    const booking = {
      bookingId,
      bookingToken,
      userId: null,
      customerId,
      name,
      email,
      phoneNumber,
      bookingDate: firebaseSdkReady ? firebase.firestore.Timestamp.fromDate(bookingDate) : bookingDate.toISOString(),
      status: "Pending",
      paymentStatus: "Unpaid",
      createdAt,
      sportKey: state.selectedSport,
      sportName: selection.sport.name,
      facilityId: selection.facility.id,
      facilityName: selection.facility.name,
      courtName: selection.facility.name,
      bookingDateLabel: formatBookingDateOnly(bookingDate),
      slotIndexes: selection.slots,
      startTime: selection.startTime,
      endTime: selection.endTime,
      timeSlot: `${selection.startTime} - ${selection.endTime}`,
      durationLabel: selection.durationLabel,
      amount: selection.price,
      players: Number(players),
    };

    if (firebaseSdkReady) {
      await db.collection("Customers").doc(customerId).set(customer);
      await bookingsRef.doc(bookingId).set(booking);
    } else if (firebaseRestReady) {
      await setFirestoreRestDocument("Customers", customerId, customer);
      await setFirestoreRestDocument("Bookings", bookingId, booking);
    } else {
      state.userBookings.unshift({ ...booking, createdAt: new Date().toISOString() });
      state.allBookings.unshift({ ...booking, createdAt: new Date().toISOString() });
    }

    const smsResult = await messageServices.sms.sendBookingConfirmation(booking).catch((error) => ({ ok: false, error }));
    const whatsappResult = await messageServices.whatsapp.sendBookingConfirmation(booking).catch((error) => ({ ok: false, error }));
    showConfirmation(booking);
    renderUserDashboard();
    renderAdminDashboard();
    renderAvailability();
    showAlert(
      smsResult.ok || whatsappResult.ok
        ? "Booking saved and confirmation message queued."
        : "Booking saved. Messaging endpoints are not configured yet.",
      smsResult.ok || whatsappResult.ok ? "success" : "info",
    );
  } catch (error) {
    showAlert(error.message || "Could not create booking. Please try again.", "error");
  } finally {
    setButtonLoading(submitButton, false);
  }
}

function showConfirmation(booking) {
  $("#confirmationId").textContent = booking.bookingId;
  $("#verificationCode").textContent = booking.bookingToken;
  $("#confirmationAmount").textContent = formatCurrency(booking.amount);
  $("#confirmationDetails").innerHTML = `
    <div><small>Name</small><strong>${booking.name}</strong></div>
    <div><small>Phone</small><strong>${booking.phoneNumber}</strong></div>
    <div><small>Email</small><strong>${booking.email}</strong></div>
    <div><small>Sport</small><strong>${booking.sportName}</strong></div>
    <div><small>Court</small><strong>${booking.courtName || booking.facilityName}</strong></div>
    <div><small>Date</small><strong>${booking.bookingDateLabel || formatBookingDateOnly(booking.bookingDate)}</strong></div>
    <div><small>Time</small><strong>${booking.timeSlot || `${booking.startTime} - ${booking.endTime}`}</strong></div>
    <div><small>Booking ID</small><strong>${booking.bookingId}</strong></div>
    <div><small>Booking Token</small><strong>${booking.bookingToken}</strong></div>
  `;
  $("#whatsappButton").href = buildWhatsAppShareUrl(booking);
  $("#downloadButton").onclick = () => downloadConfirmation(buildConfirmationMessage(booking));
  elements.detailsModal.hidden = true;
  elements.confirmationModal.hidden = false;
  elements.bookingBar.hidden = true;
  elements.bookingForm.reset();
  clearSelection();
}

function downloadConfirmation(content) {
  const blob = new Blob([content], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${$("#confirmationId").textContent}.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function closeModal(modal) {
  modal.hidden = true;
  if (elements.detailsModal.hidden && elements.confirmationModal.hidden && elements.authModal.hidden) {
    document.body.style.overflow = "";
  }
}

// Authentication System: admin login only; customers book without accounts.
function openAuthModal() {
  elements.authForm.dataset.mode = "admin";
  $("#authTitle").innerHTML = "ADMIN<br><em>LOGIN.</em>";
  $("#authSubmit").textContent = "Login";
  $("#authNameField").hidden = true;
  $("#authPhoneField").hidden = true;
  elements.authForm.elements.name.required = false;
  elements.authForm.elements.phoneNumber.required = false;
  $("#authToggleText").textContent = "Admin access only.";
  $("#authToggle").hidden = true;
  elements.authModal.hidden = false;
  document.body.style.overflow = "hidden";
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const submitButton = $("#authSubmit");
  setButtonLoading(submitButton, true, "Logging in...");

  try {
    if (!firebaseReady) throw new Error("Firebase admin authentication is not configured.");

    if (firebaseRestReady) {
      state.currentUser = await loginWithFirebaseRest({
        email: elements.authForm.elements.email.value,
        password: elements.authForm.elements.password.value,
      });
      state.currentProfile = await loadUserProfile(state.currentUser);
      if (state.currentProfile?.role !== "admin") throw new Error("Admin access is restricted.");
      updateAuthUI();
      closeModal(elements.authModal);
      showAlert("Admin logged in successfully.");
      return;
    }

    const credential = await auth.signInWithEmailAndPassword(elements.authForm.elements.email.value, elements.authForm.elements.password.value);
    state.currentProfile = await loadUserProfile(credential.user);
    if (state.currentProfile?.role !== "admin") {
      await auth.signOut();
      state.currentUser = null;
      state.currentProfile = null;
      throw new Error("Admin access is restricted.");
    }
    closeModal(elements.authModal);
    showAlert("Admin logged in successfully.");
  } catch (error) {
    if (String(error?.message || "").includes("Admin access is restricted")) {
      state.currentUser = null;
      state.currentProfile = null;
      updateAuthUI();
    }
    showAlert(getFirebaseErrorMessage(error), "error");
  } finally {
    setButtonLoading(submitButton, false);
  }
}

function buildUserProfile(user, overrides = {}) {
  return {
    uid: user.uid,
    name: (overrides.name || user.displayName || user.email.split("@")[0]).trim(),
    email: user.email,
    phoneNumber: (overrides.phoneNumber || "").trim(),
    role: overrides.role || "user",
    createdAt: firebaseSdkReady ? firebase.firestore.FieldValue.serverTimestamp() : new Date().toISOString(),
  };
}

// Registration Verification: create the Firestore user document, then read it back before reporting success.
async function saveAndVerifyUserProfile(user, overrides = {}) {
  const profileRef = firebaseSdkReady ? usersRef.doc(user.uid) : null;
  const existingDoc = firebaseSdkReady ? await profileRef.get() : await getFirestoreRestDocument("Users", user.uid, user.idToken);
  const existingData = firebaseSdkReady && existingDoc.exists ? existingDoc.data() : existingDoc;
  const profile = buildUserProfile(user, {
    ...overrides,
    role: existingData ? existingData.role || "user" : overrides.role || "user",
  });

  if (firebaseSdkReady && existingDoc.exists) {
    await profileRef.set(
      {
        uid: profile.uid,
        name: profile.name,
        email: profile.email,
        phoneNumber: profile.phoneNumber,
        role: profile.role,
      },
      { merge: true },
    );
  } else if (firebaseSdkReady) {
    await profileRef.set(profile);
  } else if (existingData) {
    await setFirestoreRestDocument(
      "Users",
      user.uid,
      {
        uid: profile.uid,
        name: profile.name,
        email: profile.email,
        phoneNumber: profile.phoneNumber,
        role: profile.role,
      },
      user.idToken,
      true,
    );
  } else {
    await setFirestoreRestDocument("Users", user.uid, profile, user.idToken);
  }

  const verifiedDoc = firebaseSdkReady ? await profileRef.get() : await getFirestoreRestDocument("Users", user.uid, user.idToken);
  if (firebaseSdkReady ? !verifiedDoc.exists : !verifiedDoc) {
    throw new Error("Registration succeeded, but the Firestore user document was not created.");
  }
  const verifiedProfile = firebaseSdkReady ? verifiedDoc.data() : verifiedDoc;
  if (verifiedProfile.uid !== user.uid || verifiedProfile.email !== user.email) {
    throw new Error("Registration profile verification failed. Please check Firestore rules.");
  }
  return verifiedProfile;
}

async function loadUserProfile(user) {
  if (!firebaseReady || !user) return;
  if (firebaseSdkReady) {
    const doc = await usersRef.doc(user.uid).get();
    if (doc.exists) {
      state.currentProfile = doc.data();
      return state.currentProfile;
    }
    state.currentProfile = await saveAndVerifyUserProfile(user);
    return state.currentProfile;
  }

  const profile = await getFirestoreRestDocument("Users", user.uid, user.idToken);
  if (profile) {
    state.currentProfile = profile;
    return state.currentProfile;
  }
  state.currentProfile = await saveAndVerifyUserProfile(user);
  return state.currentProfile;
}

// Header Role-Based UI: expose admin or user navigation according to Firestore role.
function updateAuthUI() {
  const loggedIn = Boolean(state.currentUser);
  const isAdmin = state.currentProfile?.role === "admin";
  $("#loginButton").hidden = isAdmin;
  $("#registerButton").hidden = true;
  $("#logoutButton").hidden = !loggedIn;
  $("#adminPanelButton").hidden = !loggedIn || !isAdmin;
  $("#accountName").hidden = !loggedIn;
  $("#accountName").textContent = loggedIn ? state.currentProfile?.name || state.currentUser.email : "";
}

// Firestore Live Data: admins see and manage every booking.
function subscribeToBookings() {
  if (!firebaseSdkReady) {
    renderAvailability();
    return;
  }

  if (window.unsubscribeAdminBookings) {
    window.unsubscribeAdminBookings();
  }

  window.unsubscribeAdminBookings = bookingsRef.onSnapshot(
    (snapshot) => {
      state.allBookings = snapshot.docs.map((doc) => ({
        docId: doc.id,
        ...doc.data(),
      }));

      renderAvailability();

      if (state.currentProfile?.role === "admin") {
        renderAdminDashboard();
      }
    },
    (error) => {
      console.error(error);
    }
  );
}

function showView(view) {
  state.mode = view;
  elements.playerView.hidden = view !== "player";
  elements.adminView.hidden = view !== "admin";
  elements.userDashboard.hidden = view !== "user";
  $("footer").hidden = view === "admin" || view === "user";
  elements.bookingBar.hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderStatusPill(value) {
  const className = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  return `<span class="status-pill ${className}">${value || "Unknown"}</span>`;
}

// User Dashboard: profile, history, status, payment state, and share action.
function renderUserDashboard() {
  const profile = state.currentProfile;
  $("#userProfileCard").innerHTML = profile
    ? `
      <div><small>Name</small><strong>${profile.name || "Not set"}</strong></div>
      <div><small>Email</small><strong>${profile.email || "Not set"}</strong></div>
      <div><small>Phone</small><strong>${profile.phoneNumber || "Not set"}</strong></div>
      <div><small>Role</small><strong>${profile.role || "user"}</strong></div>
    `
    : `<p class="empty-state">Login to view your profile.</p>`;

  $("#userBookingsList").innerHTML = state.userBookings.length
    ? state.userBookings
        .map(
          (booking) => `
      <article class="booking-history-card">
        <div>
          <small>${formatBookingDate(booking.bookingDate)}</small>
          <h3>${booking.sportName || "Booking"} - ${booking.courtName || booking.facilityName || "Court"}</h3>
          <p>${booking.bookingId} / ${booking.bookingToken}</p>
        </div>
        <div class="booking-statuses">${renderStatusPill(booking.status)}${renderStatusPill(booking.paymentStatus)}</div>
        <a class="share-button" target="_blank" rel="noreferrer" href="${buildWhatsAppShareUrl(booking)}">Share Booking</a>
      </article>
    `,
        )
        .join("")
    : `<p class="empty-state">No bookings yet. Your confirmed sessions will appear here.</p>`;
}

// Admin Dashboard: overview cards and booking table actions backed by Firestore updates.
function renderAdminDashboard() {
  const bookings = state.allBookings;
  const today = new Date();
  const activeBookings = bookings.filter((booking) => booking.status !== "Cancelled");
  const searchTerm = state.adminBookingSearch.trim().toLowerCase();
  const filteredBookings = searchTerm
    ? bookings.filter((booking) =>
        [booking.bookingId, booking.bookingToken, booking.name].some((value) =>
          String(value || "").toLowerCase().includes(searchTerm),
        ),
      )
    : bookings;
  const checkedIn = bookings.filter((booking) => booking.status === "Checked-In").length;
  const cancelled = bookings.filter((booking) => booking.status === "Cancelled").length;
  const paid = bookings.filter((booking) => booking.paymentStatus === "Paid").length;
  const unpaid = bookings.filter((booking) => booking.paymentStatus === "Unpaid").length;
  const expectedToday = activeBookings
    .filter((booking) => timestampToDate(booking.bookingDate)?.toDateString() === today.toDateString())
    .reduce((total, booking) => total + Number(booking.amount || 0), 0);
  const expectedMonth = activeBookings
    .filter((booking) => {
      const bookingDate = timestampToDate(booking.bookingDate);
      return bookingDate && bookingDate.getMonth() === today.getMonth() && bookingDate.getFullYear() === today.getFullYear();
    })
    .reduce((total, booking) => total + Number(booking.amount || 0), 0);

  $("#adminMetrics").innerHTML = [
    ["Total Bookings", bookings.length],
    ["Checked-In Bookings", checkedIn],
    ["Cancelled Bookings", cancelled],
    ["Paid Bookings", paid],
    ["Unpaid Bookings", unpaid],
    ["Expected Revenue Today", formatCurrency(expectedToday)],
    ["Expected Revenue This Month", formatCurrency(expectedMonth)],
  ]
    .map(
      ([label, value]) => `
      <article><div><span>${label}</span></div><strong>${value}</strong><small>Live from Firestore</small></article>
    `,
    )
    .join("");

  $("#adminBookingTable").innerHTML = filteredBookings.length
    ? filteredBookings
        .map(
          (booking) => `
      <tr>
        <td>${booking.bookingId}</td>
        <td>${booking.bookingToken}</td>
        <td>${booking.sportName || "-"}</td>
        <td>${booking.courtName || booking.facilityName || "-"}</td>
        <td>${booking.name}</td>
        <td>${booking.phoneNumber}</td>
        <td>${formatBookingDate(booking.bookingDate)}</td>
        <td>${renderStatusPill(booking.status)}</td>
        <td>${renderStatusPill(booking.paymentStatus)}</td>
        <td>
          <div class="table-actions">
            <button data-action="checked-in" data-id="${booking.docId || booking.bookingId}" type="button">Checked-In</button>
            <button data-action="paid" data-id="${booking.docId || booking.bookingId}" type="button">Paid</button>
            <button data-action="cancelled" data-id="${booking.docId || booking.bookingId}" type="button">Cancelled</button>
          </div>
        </td>
      </tr>
    `,
        )
        .join("")
    : `<tr><td colspan="11"><p class="empty-state">No bookings found.</p></td></tr>`;

  $$("#adminBookingTable [data-action]").forEach((button) => {
    button.addEventListener("click", () => updateBookingFromAdmin(button.dataset.id, button.dataset.action, button));
  });
}

async function updateBookingFromAdmin(docId, action, button) {
  if (state.currentProfile?.role !== "admin") {
    showAlert("Only admins can update bookings.", "error");
    return;
  }

  const updates =
    action === "checked-in"
      ? { status: "Checked-In" }
      : action === "paid"
        ? { paymentStatus: "Paid" }
        : { status: "Cancelled" };

  setButtonLoading(button, true, "Saving...");
  try {
    if (firebaseSdkReady) {
      await bookingsRef.doc(docId).update(updates);
    } else {
      state.allBookings = state.allBookings.map((booking) => (booking.bookingId === docId ? { ...booking, ...updates } : booking));
      state.userBookings = state.userBookings.map((booking) => (booking.bookingId === docId ? { ...booking, ...updates } : booking));
      renderAdminDashboard();
      renderUserDashboard();
    }
    showAlert("Booking updated.");
  } catch (error) {
    showAlert(error.message || "Could not update booking.", "error");
  } finally {
    setButtonLoading(button, false);
  }
}

// Admin Route Protection: block non-admins from rendering the admin panel.
function protectAdminRoute() {
  if (state.currentProfile?.role !== "admin") {
    showView("player");
    showAlert("Admin access is restricted.", "error");
    return false;
  }
  return true;
}

function bindEvents() {
  $("#continueButton").addEventListener("click", showDetailsModal);
  $("#newBookingButton").addEventListener("click", () => {
    showView("player");
    setTimeout(() => $("#book").scrollIntoView({ behavior: "smooth" }), 100);
  });
  $("#loginButton").addEventListener("click", () => openAuthModal());
  $("#adminPanelButton").addEventListener("click", () => {
    if (protectAdminRoute()) showView("admin");
  });
  $("#adminBookingSearch").addEventListener("input", (event) => {
    state.adminBookingSearch = event.target.value;
    renderAdminDashboard();
  });
  $("#logoutButton").addEventListener("click", async () => {
    if (firebaseSdkReady) await auth.signOut();
    state.currentUser = null;
    state.currentProfile = null;
    state.userBookings = [];
    updateAuthUI();
    showView("player");
    showAlert("Logged out.");
  });
  elements.authForm.addEventListener("submit", handleAuthSubmit);
  $$(".modal-close, [data-close]").forEach((button) => {
    button.addEventListener("click", () => closeModal($(`#${button.dataset.close}`)));
  });
  [elements.detailsModal, elements.confirmationModal, elements.authModal].forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal);
    });
  });
  elements.bookingForm.addEventListener("submit", (event) => {
    event.preventDefault();
    confirmBooking(new FormData(elements.bookingForm), event.submitter);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      [elements.confirmationModal, elements.detailsModal, elements.authModal].forEach((modal) => {
        if (!modal.hidden) closeModal(modal);
      });
    }
  });
}

async function bootAuth() {
  if (!firebaseReady) {
    updateAuthUI();
    subscribeToBookings();
    renderUserDashboard();
    renderAdminDashboard();
    return;
  }

  if (firebaseRestReady) {
    updateAuthUI();
    renderUserDashboard();
    subscribeToBookings();
    renderAdminDashboard();
    showAlert("Firebase config detected. Using REST fallback because Firebase SDK scripts did not load.", "info");
    return;
  }

  auth.onAuthStateChanged(async (user) => {
    state.currentUser = user;
    state.currentProfile = null;
    state.userBookings = [];
    state.allBookings = [];
    if (user) {
      await loadUserProfile(user);
      if (state.currentProfile?.role !== "admin") {
        await auth.signOut();
        state.currentUser = null;
        state.currentProfile = null;
        showAlert("Admin access is restricted.", "error");
        return;
      }
      updateAuthUI();
      subscribeToBookings();
    } else {
      updateAuthUI();
      showView("player");
      renderUserDashboard();
      subscribeToBookings();
      renderAdminDashboard();
      renderAvailability();
    }
  });
}

renderSports();
renderDates();
renderAvailability();
bindEvents();
bootAuth();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
