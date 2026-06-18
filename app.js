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
  adminBookingPage: 1,
  adminBookingPages: [],
  adminBookingQueryKey: "",
  adminBookingLoading: false,
  adminBookingRequestId: 0,
  adminBookingTotal: 0,
  adminSearchBackfillDone: false,
  staffMembers: [],
  staffLoading: false,
  editingStaffId: "",
  adminCourtStartDate: "",
  adminCourtEndDate: "",
  adminCourtSelectedDate: 0,
  adminCourtDateInitialized: false,
  adminCourtScrolledToToday: false,
  adminCourtShouldScrollToActive: false,
  customerLookupRequestId: 0,
  customerLookupTimer: null,
  customerLookupLoading: false,
  bookingLimitTimer: null,
  adminUpdateTimer: null,
  appMessageTimer: null,
  selectedBookingDate: null,
};
const ADMIN_BOOKINGS_PAGE_SIZE = 10;

const sports = {
  padel: {
    name: "Padel",
    short: "P",
    bookingCode: "A",
    unit: "Court",
    count: 2,
    maxSlots: 6,
    pricePerSlot: 1250,
    // detail: "Panoramic - Pro turf",
    players: [2, 3, 4],
  },
  pickleball: {
    name: "Pickleball",
    short: "PB",
    bookingCode: "B",
    unit: "Court",
    count: 4,
    maxSlots: 4,
    pricePerSlot: 600,
    // detail: "Competition court",
    players: [2, 3, 4],
  },
  cricket: {
    name: "Turf Cricket",
    short: "TC",
    bookingCode: "C",
    unit: "Ground",
    count: 3,
    maxSlots: 6,
    pricePerSlot: 1250,
    // detail: "Floodlit turf",
    players: [6, 8, 10, 12],
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
  bookingLimitModal: $("#bookingLimitModal"),
  confirmationModal: $("#confirmationModal"),
  adminBookingModal: $("#adminBookingModal"),
  adminUpdateModal: $("#adminUpdateModal"),
  authModal: $("#authModal"),
  bookingForm: $("#bookingForm"),
  authForm: $("#authForm"),
  playerView: $("#playerView"),
  adminView: $("#adminView"),
  userDashboard: $("#userDashboard"),
  slotMessage: $("#slotMessage"),
  alertRegion: $("#alertRegion"),
};
const pageName = document.body.dataset.page || "home";

const FIRESTORE_DATABASE = "(default)";
const FIREBASE_AUTH_BASE_URL = "https://identitytoolkit.googleapis.com/v1";
const FIRESTORE_BASE_URL = hasFirebaseConfig
  ? `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${FIRESTORE_DATABASE}/documents`
  : "";
const WEEKLY_BOOKING_LIMIT_MINUTES = 600;
const DAILY_BOOKING_LIMIT_MINUTES = 240;

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
  const queryString = !idToken && firebaseConfig.apiKey ? `?key=${encodeURIComponent(firebaseConfig.apiKey)}` : "";
  const headers = {};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const response = await fetch(`${FIRESTORE_BASE_URL}/${collection}/${docId}${queryString}`, { headers });
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Firestore read failed with status ${response.status}.`;
    throw new Error(message.replaceAll("_", " ").toLowerCase());
  }
  return fromFirestoreFields(data.fields || {});
}

async function runFirestoreRestCollectionQuery(collection, structuredQuery) {
  const queryString = firebaseConfig.apiKey ? `?key=${encodeURIComponent(firebaseConfig.apiKey)}` : "";
  const response = await firebaseRestRequest(`${FIRESTORE_BASE_URL}:runQuery${queryString}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        ...structuredQuery,
      },
    }),
  });
  return response.filter((item) => item.document);
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDurationHours(minutes) {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} ${hours === 1 ? "hour" : "hours"}`;
}

function getWeekRange(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const day = start.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + mondayOffset);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start, end };
}

function getDayRange(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start, end };
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
    date: state.selectedBookingDate || dates[state.selectedDate],
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

function toFirestoreTimestamp(date) {
  return firebaseSdkReady ? firebase.firestore.Timestamp.fromDate(date) : date;
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

function getMobileDigits(value = "") {
  const digits = String(value).replace(/\D/g, "");
  return digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits.slice(0, 10);
}

function formatIndianMobile(value = "") {
  const digits = getMobileDigits(value);
  return digits.length === 10 ? `+91${digits}` : "";
}

function isValidOptionalEmail(value = "") {
  const email = value.trim();
  return !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function findCustomerByMobile(phoneNumber) {
  if (!firebaseReady) {
    return null;
  }

  const customerId = makeCustomerId("", phoneNumber);

  if (firebaseSdkReady) {
    const customerDoc = await db.collection("Customers").doc(customerId).get();
    if (customerDoc.exists) {
      return { docId: customerDoc.id, ...customerDoc.data() };
    }

    const snapshot = await db.collection("Bookings").where("phoneNumber", "==", phoneNumber).limit(1).get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      return { docId: doc.id, ...doc.data() };
    }
    return null;
  }

  if (firebaseRestReady) {
    const customer = await getFirestoreRestDocument("Customers", customerId);
    if (customer) return { docId: customerId, ...customer };

    const matches = await runFirestoreRestCollectionQuery("Bookings", {
      where: {
        fieldFilter: {
          field: { fieldPath: "phoneNumber" },
          op: "EQUAL",
          value: { stringValue: phoneNumber },
        },
      },
      limit: 1,
    });
    if (matches.length) {
      const document = matches[0].document;
      return { docId: document.name.split("/").pop(), ...fromFirestoreFields(document.fields || {}) };
    }
  }

  return null;
}

function setBookingSubmitDisabled(disabled) {
  const button = elements.bookingForm?.querySelector(".form-submit");
  if (button && !button.dataset.originalText) button.disabled = disabled;
}

function setCustomerLookupStatus(message = "", type = "") {
  const status = $("#customerLookupStatus");
  if (status) {
    status.textContent = message;
    status.className = `lookup-status ${type}`.trim();
  }
  const indicator = $("#customerLookupIndicator");
  if (!indicator) return;
  indicator.className = `lookup-indicator ${type === "loading" || type === "success" ? type : ""}`.trim();
  indicator.setAttribute("aria-hidden", type === "loading" || type === "success" ? "false" : "true");
  indicator.setAttribute("aria-label", type === "loading" ? "Checking customer" : type === "success" ? "Customer found" : "");
}

async function lookupCustomerFromMobile() {
  if (!elements.bookingForm) return;
  const requestId = ++state.customerLookupRequestId;
  const mobileInput = elements.bookingForm.elements.mobile;
  const digits = getMobileDigits(mobileInput.value);

  if (digits.length !== 10) {
    state.customerLookupLoading = false;
    setBookingSubmitDisabled(false);
    setCustomerLookupStatus("");
    return;
  }

  state.customerLookupLoading = true;
  setBookingSubmitDisabled(true);
  setCustomerLookupStatus("", "loading");

  try {
    const customer = await findCustomerByMobile(`+91${digits}`);
    if (requestId !== state.customerLookupRequestId) return;

    if (customer) {
      elements.bookingForm.elements.name.value = customer.name || elements.bookingForm.elements.name.value;
      elements.bookingForm.elements.email.value = customer.email || elements.bookingForm.elements.email.value;
      setCustomerLookupStatus("Customer found. Details filled.", "success");
    } else {
      setCustomerLookupStatus("");
    }
  } catch (error) {
    if (requestId === state.customerLookupRequestId) {
      console.warn("Customer lookup failed", error);
      setCustomerLookupStatus("");
    }
  } finally {
    if (requestId === state.customerLookupRequestId) {
      state.customerLookupLoading = false;
      setBookingSubmitDisabled(false);
    }
  }
}

function handleBookingMobileInput(event) {
  hideBookingLimitModal();
  const input = event.target;
  input.value = getMobileDigits(input.value);
  clearTimeout(state.customerLookupTimer);
  setCustomerLookupStatus("");
  if (input.value.length === 10) {
    state.customerLookupTimer = setTimeout(lookupCustomerFromMobile, 250);
  }
}

function showAlert(message, type = "success") {
  let modal = $("#appMessageModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.className = "modal-backdrop app-message-backdrop";
    modal.id = "appMessageModal";
    modal.hidden = true;
    modal.innerHTML = `
      <section class="modal limit-modal app-message-modal">
        <button class="modal-close" data-app-message-close type="button">&times;</button>
        <p class="eyebrow dark centered"><span></span> Notice <span></span></p>
        <h2 id="appMessageTitle">UPDATED<em>.</em></h2>
        <p id="appMessageText"></p>
      </section>
    `;
    document.body.appendChild(modal);
    modal.querySelector("[data-app-message-close]")?.addEventListener("click", () => hideAppMessageModal());
    modal.addEventListener("click", (event) => {
      if (event.target === modal) hideAppMessageModal();
    });
  }

  const title = $("#appMessageTitle");
  const text = $("#appMessageText");
  modal.className = `modal-backdrop app-message-backdrop ${type}`;
  if (title) {
    const label = type === "error" ? "ERROR" : type === "info" ? "NOTICE" : "UPDATED";
    title.innerHTML = `${label}<em>.</em>`;
  }
  if (text) text.textContent = message;
  clearTimeout(state.appMessageTimer);
  modal.hidden = false;
  state.appMessageTimer = setTimeout(hideAppMessageModal, 5000);
}

function hideAppMessageModal() {
  clearTimeout(state.appMessageTimer);
  const modal = $("#appMessageModal");
  if (modal) modal.hidden = true;
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
    return "Firestore rejected this write. Deploy the latest firestore.rules and indexes, then hard refresh the app.";
  }

  return error?.message || "Something went wrong. Please try again.";
}

function isAdminProfile() {
  return state.currentProfile?.role === "admin";
}

function isStaffProfile() {
  return state.currentProfile?.role === "staff";
}

function canAccessAdminArea() {
  return isAdminProfile() || isStaffProfile();
}

function canManageStaff() {
  return isAdminProfile();
}

function canMutateBookings() {
  return isAdminProfile();
}

function setButtonLoading(button, loading, label = "Working...") {
  if (!button) return;
  if (loading) {
    if (!button.dataset.originalText) button.dataset.originalText = button.innerHTML;
    button.innerHTML = `<span class="button-spinner"></span>${label}`;
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.originalText || button.innerHTML;
    delete button.dataset.originalText;
    button.disabled = false;
  }
}

function clearSelection() {
  state.selectedFacilityId = null;
  state.selectedSlots = [];
  state.selectedBookingDate = null;
  if (elements.bookingBar) elements.bookingBar.hidden = true;
  hideMessage();
}

function renderSports() {
  if (!elements.sportOptions) return;
  elements.sportOptions.innerHTML = Object.entries(sports)
    .map(
      ([key, sport]) => `
    <button class="sport-button ${state.selectedSport === key ? "active" : ""}" data-sport="${key}" type="button">
      <span class="sport-icon">${sport.short}</span>
      <span><strong>${sport.name}</strong><small>${sport.count} ${sport.unit.toLowerCase()}${sport.count > 1 ? "s" : ""}</small></span>
    </button>
  `,
    )
    .join("");

  $$("[data-sport]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSport = button.dataset.sport;
      clearSelection();
      renderSports();
      renderDates();
      renderAvailability();
    });
  });
}

function renderDates() {
  if (!elements.dateScroller) return;
  elements.dateScroller.innerHTML = dates
    .map((date, index) => {
      const day = index === 0 ? "Today" : date.toLocaleDateString("en-IN", { weekday: "short" });
      const month = date.toLocaleDateString("en-IN", { month: "short" });
      const availabilityClass = getDateAvailabilityClass(index);
      return `
      <button class="date-button ${availabilityClass} ${state.selectedDate === index ? "active" : ""}" data-date="${index}" type="button">
        <small>${day}</small>
        <strong>${String(date.getDate()).padStart(2, "0")}</strong>
        <em>${month}</em>
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

function cloneDateAtNoon(date) {
  const clone = new Date(date);
  clone.setHours(12, 0, 0, 0);
  return clone;
}

function formatDateInput(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseDateInput(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, days) {
  const nextDate = cloneDateAtNoon(date);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate;
}

function getCurrentMonthDateRange() {
  const today = cloneDateAtNoon(new Date());
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1, 12, 0, 0, 0);
  const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0, 12, 0, 0, 0);
  return { startDate, endDate, today };
}

function ensureAdminCourtDateRange() {
  const { startDate, endDate, today } = getCurrentMonthDateRange();
  if (!state.adminCourtStartDate) state.adminCourtStartDate = formatDateInput(startDate);
  if (!state.adminCourtEndDate) state.adminCourtEndDate = formatDateInput(endDate);
  if (!state.adminCourtDateInitialized) {
    state.adminCourtSelectedDate = today.getDate() - 1;
    state.adminCourtDateInitialized = true;
  }
}

function getAdminCourtDates() {
  ensureAdminCourtDateRange();
  let startDate = parseDateInput(state.adminCourtStartDate) || dates[0];
  let endDate = parseDateInput(state.adminCourtEndDate) || dates[dates.length - 1];

  if (endDate < startDate) {
    [startDate, endDate] = [endDate, startDate];
  }

  const range = [];
  const cursor = cloneDateAtNoon(startDate);
  while (cursor <= endDate && range.length < 370) {
    range.push(cloneDateAtNoon(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return range.length ? range : [cloneDateAtNoon(startDate)];
}

function getSelectedAdminCourtDate() {
  const adminDates = getAdminCourtDates();
  state.adminCourtSelectedDate = Math.min(Math.max(state.adminCourtSelectedDate, 0), adminDates.length - 1);
  return adminDates[state.adminCourtSelectedDate];
}

function isBookedForSlotOnDate(sportKey, selectedDate, facilityId, slotIndex) {
  return state.allBookings.some((booking) => {
    if (booking.status === "Cancelled") return false;
    const date = timestampToDate(booking.bookingDate);
    return (
      booking.sportKey === sportKey &&
      Number(booking.facilityId) === facilityId &&
      booking.slotIndexes?.includes(slotIndex) &&
      date?.toDateString() === selectedDate.toDateString()
    );
  });
}

function isBookedForSlot(sportKey, dateIndex, facilityId, slotIndex) {
  return isBookedForSlotOnDate(sportKey, dates[dateIndex], facilityId, slotIndex);
}

function isUnavailableForDate(sportKey, selectedDate, facilityId, slotIndex) {
  return isBookedForSlotOnDate(sportKey, selectedDate, facilityId, slotIndex);
}

function isUnavailableFor(sportKey, dateIndex, facilityId, slotIndex) {
  return isUnavailableForDate(sportKey, dates[dateIndex], facilityId, slotIndex);
}

function isUnavailable(facilityId, slotIndex) {
  return isUnavailableFor(state.selectedSport, state.selectedDate, facilityId, slotIndex);
}

function isPastSlotFor(dateIndex, slotIndex) {
  return isPastSlotForDate(dates[dateIndex], slotIndex);
}

function isPastSlotForDate(selectedDate, slotIndex) {
  const now = new Date();
  const slotStart = new Date(selectedDate);
  slotStart.setHours(6, slotIndex * 30, 0, 0);
  const latestSelectableStart = new Date(now.getTime() + 10 * 60 * 1000);
  return selectedDate.toDateString() === now.toDateString() && slotStart <= latestSelectableStart;
}

function getMaxConsecutiveAvailableSlotsForDate(sportKey, selectedDate) {
  const sport = sports[sportKey] || getSport();
  return Array.from({ length: sport.count }, (_, index) => index + 1).reduce((bestOverall, facilityId) => {
    let currentRun = 0;
    let bestForFacility = 0;

    times.forEach((_, slotIndex) => {
      const available = !isPastSlotForDate(selectedDate, slotIndex) && !isUnavailableForDate(sportKey, selectedDate, facilityId, slotIndex);
      if (available) {
        currentRun += 1;
        bestForFacility = Math.max(bestForFacility, currentRun);
      } else {
        currentRun = 0;
      }
    });

    return Math.max(bestOverall, bestForFacility);
  }, 0);
}

function getMaxConsecutiveAvailableSlots(dateIndex) {
  return getMaxConsecutiveAvailableSlotsForDate(state.selectedSport, dates[dateIndex]);
}

function getDateAvailabilityClassForDate(sportKey, selectedDate) {
  const maxConsecutiveSlots = getMaxConsecutiveAvailableSlotsForDate(sportKey, selectedDate);
  if (maxConsecutiveSlots > 8) return "availability-green";
  if (maxConsecutiveSlots >= 3) return "availability-orange";
  return "availability-red";
}

function getDateAvailabilityClass(dateIndex) {
  return getDateAvailabilityClassForDate(state.selectedSport, dates[dateIndex]);
}

function isPastSlot(slotIndex) {
  return isPastSlotFor(state.selectedDate, slotIndex);
}

function renderAvailability() {
  if (!elements.availabilityGrid) return;
  const sport = getSport();
  const selectedDate = dates[state.selectedDate];
  const facilities = getFacilities();
  $("#availabilityTitle").textContent = `${sport.name} - ${selectedDate.toLocaleDateString("en-IN", {
    weekday: "short",
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
      <div class="facility-heading"><div class="facility-title-row"><span>${sport.short}${facility.id}</span></div></div>
    `,
      )
      .join("")}
    ${times
      .map((time, slotIndex) => ({ time, slotIndex }))
      .filter(({ slotIndex }) => !isPastSlot(slotIndex))
      .map(
        ({ time, slotIndex }) => `
      <div class="time-label"><strong>${time}</strong><small>${minutesToTime(360 + (slotIndex + 1) * 30)}</small></div>
      ${facilities
        .map((facility) => {
          const unavailable = isUnavailable(facility.id, slotIndex);
          const selected = state.selectedFacilityId === facility.id && state.selectedSlots.includes(slotIndex);
          const edgeStart = selected && slotIndex === Math.min(...state.selectedSlots);
          const edgeEnd = selected && slotIndex === Math.max(...state.selectedSlots);
          return `<button
            class="slot-cell ${unavailable ? "unavailable" : "available"} ${selected ? "selected" : ""} ${edgeStart ? "edge-start" : ""} ${edgeEnd ? "edge-end" : ""}"
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

function getAdminSlotBooking(facilityId, slotIndex) {
  const selectedDate = getSelectedAdminCourtDate();
  return state.allBookings.find((booking) => {
    const bookingDate = timestampToDate(booking.bookingDate);
    return (
      booking.sportKey === state.selectedSport &&
      Number(booking.facilityId) === facilityId &&
      booking.slotIndexes?.includes(slotIndex) &&
      bookingDate?.toDateString() === selectedDate.toDateString()
    );
  });
}

function getAdminBookingSlotClass(booking) {
  if (!booking) return "";
  if (booking.status === "Cancelled") return "cancelled";
  if (booking.paymentStatus === "Paid") return "paid";
  return "unpaid";
}

function getAdminBookingId(booking) {
  return booking?.docId || booking?.bookingId || "";
}

function getAdminBookingById(id) {
  return state.allBookings.find((booking) => getAdminBookingId(booking) === id || booking.bookingId === id);
}

function selectAdminSlot(facilityId, slotIndex) {
  if (!canMutateBookings()) {
    showAlert("Staff can view bookings only.", "error");
    return;
  }

  hideBookingLimitModal();
  const selectedDate = getSelectedAdminCourtDate();
  state.selectedBookingDate = cloneDateAtNoon(selectedDate);

  if (isUnavailableForDate(state.selectedSport, selectedDate, facilityId, slotIndex)) {
    showAlert("This time slot cannot be selected.", "error");
    renderAdminCourtBooking();
    return;
  }

  const sport = getSport();
  const selected = [...state.selectedSlots].sort((a, b) => a - b);

  if (state.selectedFacilityId !== facilityId || selected.length === 0) {
    state.selectedFacilityId = facilityId;
    state.selectedSlots = [slotIndex];
  } else if (selected.includes(slotIndex)) {
    if (selected.length === 1) {
      clearSelection();
    } else if (slotIndex === selected[0] || slotIndex === selected[selected.length - 1]) {
      state.selectedSlots = selected.filter((value) => value !== slotIndex);
    } else {
      state.selectedSlots = [slotIndex];
    }
  } else if (slotIndex === selected[0] - 1 || slotIndex === selected[selected.length - 1] + 1) {
    if (selected.length >= sport.maxSlots) {
      showAlert(`${sport.name} bookings can be up to ${sport.maxSlots / 2} hours.`, "error");
    } else {
      state.selectedSlots = [...selected, slotIndex].sort((a, b) => a - b);
    }
  } else {
    state.selectedSlots = [slotIndex];
  }

  updateBookingBar();
  renderAdminCourtBooking();
}

function renderAdminBookingModalActions(booking) {
  const actionsElement = $("#adminBookingModalActions");
  if (!actionsElement) return;

  if (!canMutateBookings()) {
    actionsElement.innerHTML = `<p class="empty-state">View only access.</p>`;
    return;
  }

  const id = getAdminBookingId(booking);
  const actions = [];
  if (booking.paymentStatus !== "Paid" && booking.status !== "Cancelled") actions.push(["paid", "Paid"]);
  if (booking.status !== "Cancelled") actions.push(["cancelled", "Cancel"]);

  actionsElement.innerHTML = actions.length
    ? actions
        .map(([action, label]) => `<button class="primary-cta compact ${action === "cancelled" ? "danger" : ""}" data-modal-action="${action}" data-id="${id}" type="button">${label}</button>`)
        .join("")
    : `<p class="empty-state">No actions available.</p>`;

  $$("#adminBookingModalActions [data-modal-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      await updateBookingFromAdmin(button.dataset.id, button.dataset.modalAction, button);
      const updatedBooking = getAdminBookingById(button.dataset.id);
      if (updatedBooking) openAdminBookingModal(updatedBooking);
    });
  });
}

function getBookingCourtBadge(booking = {}) {
  const sportShort = sports[booking.sportKey]?.short || (booking.sportName || "").trim().charAt(0).toUpperCase() || "P";
  const facilityId = Number(booking.facilityId);
  if (facilityId) return `${sportShort}${facilityId}`;
  const courtNumber = String(booking.courtName || booking.facilityName || "").match(/\d+/)?.[0];
  return courtNumber ? `${sportShort}${courtNumber}` : sportShort;
}

function getBookingAmountStatusLabel(booking = {}) {
  return booking.paymentStatus === "Paid" ? "Paid" : "Due";
}

async function findBookingByToken(bookingToken) {
  const token = String(bookingToken || "").trim();
  if (!token || !firebaseReady) return null;
  const tokenField = token.length > 12 ? "confirmationToken" : "bookingToken";

  if (firebaseSdkReady) {
    const snapshot = await bookingsRef.where(tokenField, "==", token).limit(1).get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    return { docId: doc.id, ...doc.data() };
  }

  if (firebaseRestReady) {
    const matches = await runFirestoreRestCollectionQuery("Bookings", {
      where: {
        fieldFilter: {
          field: { fieldPath: tokenField },
          op: "EQUAL",
          value: { stringValue: token },
        },
      },
      limit: 1,
    });
    if (!matches.length) return null;
    const document = matches[0].document;
    return { docId: document.name.split("/").pop(), ...fromFirestoreFields(document.fields || {}) };
  }

  return null;
}

function renderConfirmationCard(booking) {
  $("#confirmationId").textContent = booking.bookingId || "-";
  $("#verificationCode").textContent = booking.bookingToken || "-";
  $("#confirmationAmount").textContent = formatCurrency(booking.amount || 0);
  if ($("#confirmationAmountStatus")) $("#confirmationAmountStatus").textContent = `Amount ${getBookingAmountStatusLabel(booking)}`;
  $("#confirmationDetails").innerHTML = `
    <div class="admin-booking-half"><small>Name</small><strong>${booking.name || "-"}</strong></div>
    <div class="admin-booking-half"><small>Mobile</small><strong>${booking.phoneNumber || "-"}</strong></div>
    <div class="admin-booking-court"><small>Sport</small><strong>${getBookingCourtBadge(booking)}</strong></div>
    <div><small>Date</small><strong>${booking.bookingDateLabel || formatBookingDateOnly(booking.bookingDate)}</strong></div>
    <div><small>Time</small><strong>${booking.timeSlot || `${booking.startTime || "-"} - ${booking.endTime || "-"}`}</strong></div>
  `;
}

function showConfirmationExpired(message = "This booking confirmation link has expired.") {
  const messageElement = $("#publicConfirmMessage");
  if (messageElement) {
    messageElement.hidden = false;
    messageElement.textContent = message;
  }
  const ticket = $("#publicConfirmTicket");
  if (ticket) ticket.hidden = true;
  const mark = $(".success-mark");
  if (mark) {
    mark.textContent = "!";
    mark.classList.add("expired");
  }
  const title = $(".public-confirm-card h2");
  if (title) title.innerHTML = "LINK<em>EXPIRED.</em>";
}

async function renderPublicBookingConfirmation() {
  const token = new URLSearchParams(window.location.search).get("token");
  const messageElement = $("#publicConfirmMessage");
  const ticket = $("#publicConfirmTicket");

  if (!token) {
    showConfirmationExpired("Booking token missing. Please use the confirmation link sent to you.");
    return;
  }

  try {
    const booking = await findBookingByToken(token);
    if (!booking || booking.status === "Cancelled") {
      showConfirmationExpired("This booking confirmation link has expired.");
      return;
    }
    renderConfirmationCard(booking);
    if (messageElement) {
      messageElement.textContent = "";
      messageElement.hidden = true;
    }
    $$(".confirmationPaymentNote").forEach((paymentNote) => {
      paymentNote.hidden = booking.paymentStatus === "Paid";
    });
    if (ticket) ticket.hidden = false;
  } catch (error) {
    console.error(error);
    showConfirmationExpired("This booking confirmation link has expired.");
  }
}

function openAdminBookingModal(booking) {
  const modal = $("#adminBookingModal");
  const top = $("#adminBookingModalTop");
  const summary = $("#adminBookingModalSummary");
  if (!modal || !summary || !booking) return;

  if (top) {
    top.innerHTML = `
      <div><small>Booking ID</small><strong>${booking.bookingId || "-"}</strong></div>
      <div><small>Unique Code</small><strong class="code">${booking.bookingToken || "-"}</strong></div>
    `;
  }

  summary.innerHTML = `
    <div class="admin-booking-half"><small>Name</small><strong>${booking.name || "-"}</strong></div>
    <div class="admin-booking-half"><small>Mobile</small><strong>${booking.phoneNumber || "-"}</strong></div>
    <div class="admin-booking-court"><small>Sport</small><strong>${getBookingCourtBadge(booking)}</strong></div>
    <div><small>Date</small><strong>${booking.bookingDateLabel || formatBookingDateOnly(booking.bookingDate)}</strong></div>
    <div><small>Time</small><strong>${booking.timeSlot || `${booking.startTime || "-"} - ${booking.endTime || "-"}`}</strong></div>
    <div class="admin-booking-amount"><small>Amount ${getBookingAmountStatusLabel(booking)}</small><strong>${formatCurrency(booking.amount || 0)}</strong></div>
  `;
  renderAdminBookingModalActions(booking);
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function getAdminBookingSlotMerge(booking, slotIndex) {
  const slots = [...(booking?.slotIndexes || [])].sort((a, b) => a - b);
  if (!slots.length || !slots.includes(slotIndex)) {
    return { isStart: false, isContinuation: false, span: 1 };
  }

  const isStart = !slots.includes(slotIndex - 1);
  let span = 1;
  while (slots.includes(slotIndex + span)) span += 1;

  return {
    isStart,
    isContinuation: !isStart,
    span,
  };
}

async function loadAdminCourtBookingsForRange() {
  if (!firebaseSdkReady || !bookingsRef) return;
  const adminDates = getAdminCourtDates();
  const startDate = new Date(adminDates[0]);
  const endDate = new Date(adminDates[adminDates.length - 1]);
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);

  const snapshot = await bookingsRef
    .where("bookingDate", ">=", toFirestoreTimestamp(startDate))
    .where("bookingDate", "<=", toFirestoreTimestamp(endDate))
    .get();

  const bookingMap = new Map(state.allBookings.map((booking) => [booking.docId || booking.bookingId, booking]));
  snapshot.docs.forEach((doc) => {
    bookingMap.set(doc.id, {
      docId: doc.id,
      ...doc.data(),
    });
  });
  state.allBookings = Array.from(bookingMap.values());
}

function renderAdminCourtFilters() {
  const sportOptions = $("#adminCourtSportOptions");
  const dateScroller = $("#adminCourtDateScroller");
  const startInput = $("#adminCourtStartDate");
  const endInput = $("#adminCourtEndDate");
  const adminDates = getAdminCourtDates();

  if (startInput && endInput) {
    startInput.value = state.adminCourtStartDate;
    endInput.value = state.adminCourtEndDate;

    if (!startInput.dataset.bound) {
      startInput.dataset.bound = "true";
      startInput.addEventListener("change", () => {
        state.adminCourtStartDate = startInput.value;
        state.adminCourtSelectedDate = 0;
        state.adminCourtShouldScrollToActive = true;
        state.adminCourtScrolledToToday = false;
        renderAdminCourtBooking();
        loadAdminCourtBookingsForRange().then(renderAdminCourtBooking).catch((error) => console.error(error));
      });
    }

    if (!endInput.dataset.bound) {
      endInput.dataset.bound = "true";
      endInput.addEventListener("change", () => {
        state.adminCourtEndDate = endInput.value;
        state.adminCourtSelectedDate = 0;
        state.adminCourtShouldScrollToActive = true;
        state.adminCourtScrolledToToday = false;
        renderAdminCourtBooking();
        loadAdminCourtBookingsForRange().then(renderAdminCourtBooking).catch((error) => console.error(error));
      });
    }
  }

  if (sportOptions) {
    sportOptions.innerHTML = Object.entries(sports)
      .map(
        ([key, sport]) => `
      <button class="sport-button ${state.selectedSport === key ? "active" : ""}" data-admin-sport="${key}" type="button">
        <span class="sport-icon">${sport.short}</span>
        <span><strong>${sport.name}</strong><small>${sport.count} ${sport.unit.toLowerCase()}${sport.count > 1 ? "s" : ""}</small></span>
      </button>
    `,
      )
      .join("");

    $$("[data-admin-sport]").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedSport = button.dataset.adminSport;
        clearSelection();
        renderAdminCourtBooking();
      });
    });
  }

  if (dateScroller) {
    dateScroller.style.setProperty("--admin-date-count", adminDates.length);
    dateScroller.innerHTML = adminDates
      .map((date, index) => {
      const day = date.toLocaleDateString("en-IN", { weekday: "short" });
      const month = date.toLocaleDateString("en-IN", { month: "short" });
      const availabilityClass = getDateAvailabilityClassForDate(state.selectedSport, date);
      return `
      <button class="date-button ${availabilityClass} ${state.adminCourtSelectedDate === index ? "active" : ""}" data-admin-date="${index}" type="button">
        <small>${day}</small>
        <strong>${String(date.getDate()).padStart(2, "0")}</strong>
        <em>${month}</em>
        <i></i>
      </button>
    `;
      })
      .join("");

    $$("[data-admin-date]").forEach((button) => {
      button.addEventListener("click", () => {
        state.adminCourtSelectedDate = Number(button.dataset.adminDate);
        clearSelection();
        renderAdminCourtBooking();
      });
    });

    if (state.adminCourtShouldScrollToActive || !state.adminCourtScrolledToToday) requestAnimationFrame(() => {
      const activeDate = dateScroller.querySelector("[data-admin-date].active");
      if (!activeDate) return;
      const scrollerRect = dateScroller.getBoundingClientRect();
      const activeRect = activeDate.getBoundingClientRect();
      state.adminCourtScrolledToToday = true;
      state.adminCourtShouldScrollToActive = false;
      dateScroller.scrollTo({
        left: Math.max(0, dateScroller.scrollLeft + activeRect.left - scrollerRect.left),
        behavior: "auto",
      });
    });
  }
}

function renderAdminCourtBooking() {
  const grid = $("#adminCourtBookingGrid");
  if (!grid) return;

  const sport = getSport();
  const selectedDate = getSelectedAdminCourtDate();
  const facilities = getFacilities();
  const title = $("#adminCourtBookingTitle");

  if (title) {
    title.textContent = `${sport.name} - ${selectedDate.toLocaleDateString("en-IN", {
      weekday: "long",
      day: "2-digit",
      month: "short",
    })}`;
  }

  renderAdminCourtFilters();
  grid.style.setProperty("--facility-count", facilities.length);
  grid.style.gridTemplateRows = `73px repeat(${times.length}, var(--admin-booking-row-height))`;
  grid.innerHTML = `
    <div class="availability-corner" style="grid-column: 1; grid-row: 1;"><span>Time</span><small>30 min slots</small></div>
    ${facilities
      .map(
        (facility, facilityIndex) => `
      <div class="facility-heading" style="grid-column: ${facilityIndex + 2}; grid-row: 1;"><div class="facility-title-row"><span>${sport.short}${facility.id}</span></div></div>
    `,
      )
      .join("")}
    ${times
      .map((time, slotIndex) => ({ time, slotIndex }))
      .map(
        ({ time, slotIndex }) => `
      <div class="time-label" style="grid-column: 1; grid-row: ${slotIndex + 2};"><strong>${time}</strong><small>${minutesToTime(360 + (slotIndex + 1) * 30)}</small></div>
      ${facilities
        .map((facility, facilityIndex) => {
          const booking = getAdminSlotBooking(facility.id, slotIndex);
          const className = getAdminBookingSlotClass(booking);
          const merge = getAdminBookingSlotMerge(booking, slotIndex);
          const selected = !booking && state.selectedBookingDate?.toDateString() === selectedDate.toDateString() && state.selectedFacilityId === facility.id && state.selectedSlots.includes(slotIndex);

          if (merge.isContinuation) {
            return "";
          }

          return `<button class="admin-booking-slot ${booking ? className : "available"} ${selected ? "selected" : ""} ${merge.isStart ? "merged-start" : ""}" data-admin-booking-id="${booking ? getAdminBookingId(booking) : ""}" ${!booking && canMutateBookings() ? `data-admin-facility="${facility.id}" data-admin-slot="${slotIndex}"` : ""} style="grid-column: ${facilityIndex + 2}; grid-row: ${slotIndex + 2} / span ${merge.span};" type="button" ${!booking && !canMutateBookings() ? "disabled" : ""}>
            ${
              booking
                ? `<div class="admin-booking-slot-content"><span>${booking.name || "Guest"}</span><span>${booking.phoneNumber || "-"}</span><small>${booking.paymentStatus || "-"}</small></div>`
                : `<span>Available</span>`
            }
          </button>`;
        })
        .join("")}
    `,
      )
      .join("")}
  `;

  $$("#adminCourtBookingGrid [data-admin-booking-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const booking = getAdminBookingById(button.dataset.adminBookingId);
      if (booking) openAdminBookingModal(booking);
    });
  });
  $$("#adminCourtBookingGrid [data-admin-facility][data-admin-slot]").forEach((button) => {
    button.addEventListener("click", () => selectAdminSlot(Number(button.dataset.adminFacility), Number(button.dataset.adminSlot)));
  });
}

function selectSlot(facilityId, slotIndex) {
  hideBookingLimitModal();
  if (isPastSlot(slotIndex) || isUnavailable(facilityId, slotIndex)) {
    showMessage("This time slot cannot be selected.", "error");
    renderAvailability();
    return;
  }

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
  if (!elements.slotMessage) return;
  elements.slotMessage.textContent = message;
  elements.slotMessage.className = `slot-message ${type}`;
  elements.slotMessage.hidden = false;
}

function hideMessage() {
  if (!elements.slotMessage) return;
  elements.slotMessage.hidden = true;
}

function showBookingLimitModal(message) {
  if (!elements.bookingLimitModal) return;
  const messageElement = $("#bookingLimitMessage");
  if (messageElement) messageElement.textContent = message;
  clearTimeout(state.bookingLimitTimer);
  elements.bookingLimitModal.hidden = false;
  state.bookingLimitTimer = setTimeout(() => closeModal(elements.bookingLimitModal), 30000);
}

function hideBookingLimitModal() {
  clearTimeout(state.bookingLimitTimer);
  if (elements.bookingLimitModal) elements.bookingLimitModal.hidden = true;
}

function showAdminUpdateModal(message = "Booking updated.") {
  if (!elements.adminUpdateModal) return;
  const messageElement = $("#adminUpdateMessage");
  if (messageElement) messageElement.textContent = message;
  clearTimeout(state.adminUpdateTimer);
  elements.adminUpdateModal.hidden = false;
  state.adminUpdateTimer = setTimeout(() => closeModal(elements.adminUpdateModal), 5000);
}

function updateBookingBar() {
  if (!elements.bookingBar) return;
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
  if (!elements.detailsModal || !elements.bookingForm) return;
  const selection = getSelection();
  if (state.selectedSlots.length < 2) {
    showMessage("Please select at least two consecutive 30-minute slots to make a 1-hour booking.", "error");
    ($("#book") || $("#adminCourtBookingGrid"))?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  $("#modalSummary").innerHTML = `
  <div class="modal-summary-court">
    <small>Sport</small>
    <strong>${selection.sport.short}${selection.facility.id}</strong>
  </div>
  <div>
    <small>Date</small>
    <strong>${selection.date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</strong>
  </div>
  <div>
    <small>Time</small>
    <strong class="modal-summary-time">${selection.startTime} - ${selection.endTime}</strong>
  </div>
  <div>
    <small>Amount</small>
    <strong>${formatCurrency(selection.price)}</strong>
  </div>
  `;
  $("#playerOptions").innerHTML = selection.sport.players
    .map(
      (players, index) => `
  `,
    )
    .join("");

  elements.bookingForm.elements.name.value = "";
  elements.bookingForm.elements.mobile.value = "";
  elements.bookingForm.elements.email.value = "";
  setCustomerLookupStatus("");
  hideBookingLimitModal();
  setBookingSubmitDisabled(false);
  elements.detailsModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function makeAlphaNumericCode(length) {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const numbers = "123456789";
  const chars = `${letters}${numbers}`;
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const code = Array.from(bytes, (byte) => chars[byte % chars.length]).join("");

  if (!/[A-Z]/.test(code) || !/\d/.test(code)) {
    return makeAlphaNumericCode(length);
  }
  return code;
}

async function bookingDocumentExists(bookingId) {
  if (state.allBookings.some((booking) => String(booking.bookingId) === bookingId || String(booking.docId) === bookingId)) return true;
  if (firebaseSdkReady) {
    const doc = await bookingsRef.doc(bookingId).get();
    return doc.exists;
  }
  if (firebaseRestReady) {
    const doc = await getFirestoreRestDocument("Bookings", bookingId);
    return Boolean(doc);
  }
  return false;
}

function getBookingMonthPrefix(bookingDate) {
  return String((bookingDate.getMonth() + 1)).padStart(2, "0");
}

function getBookingIdPrefix(sportKey, bookingDate) {
  return `${getBookingMonthPrefix(bookingDate)}${sports[sportKey]?.bookingCode || "A"}`;
}

async function fetchBookingsByIdPrefix(prefix) {
  const localMatches = state.allBookings.filter((booking) => String(booking.bookingId || "").startsWith(prefix));

  if (firebaseSdkReady) {
    const snapshot = await bookingsRef
      .where("bookingId", ">=", prefix)
      .where("bookingId", "<", `${prefix}\uf8ff`)
      .limit(1000)
      .get();
    const remoteMatches = snapshot.docs.map((doc) => ({ docId: doc.id, ...doc.data() }));
    const byId = new Map([...localMatches, ...remoteMatches].map((booking) => [booking.docId || booking.bookingId, booking]));
    return Array.from(byId.values());
  }

  if (firebaseRestReady) {
    const matches = await runFirestoreRestCollectionQuery("Bookings", {
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "bookingId" },
                op: "GREATER_THAN_OR_EQUAL",
                value: { stringValue: prefix },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: "bookingId" },
                op: "LESS_THAN",
                value: { stringValue: `${prefix}\uf8ff` },
              },
            },
          ],
        },
      },
      limit: 1000,
    });
    const remoteMatches = matches.map((item) => ({
      docId: item.document.name.split("/").pop(),
      ...fromFirestoreFields(item.document.fields || {}),
    }));
    const byId = new Map([...localMatches, ...remoteMatches].map((booking) => [booking.docId || booking.bookingId, booking]));
    return Array.from(byId.values());
  }

  return localMatches;
}

async function bookingTokenExists(bookingToken) {
  if (state.allBookings.some((booking) => String(booking.bookingToken) === bookingToken)) return true;
  if (firebaseSdkReady) {
    const snapshot = await bookingsRef.where("bookingToken", "==", bookingToken).limit(1).get();
    return !snapshot.empty;
  }
  if (firebaseRestReady) {
    const matches = await runFirestoreRestCollectionQuery("Bookings", {
      where: {
        fieldFilter: {
          field: { fieldPath: "bookingToken" },
          op: "EQUAL",
          value: { stringValue: bookingToken },
        },
      },
      limit: 1,
    });
    return matches.length > 0;
  }
  return false;
}

async function makeUniqueAlphaNumericCode(length, existsCheck) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const code = makeAlphaNumericCode(length);
    if (!(await existsCheck(code))) return code;
  }
  throw new Error(`Could not generate a unique ${length}-character code. Please try again.`);
}

async function makeBookingReference(sportKey, bookingDate) {
  const monthPrefix = getBookingMonthPrefix(bookingDate);
  const bookingIdPrefix = getBookingIdPrefix(sportKey, bookingDate);
  const existingBookings = await fetchBookingsByIdPrefix(monthPrefix);
  const highestSequence = existingBookings.reduce((highest, booking) => {
    const match = String(booking.bookingId || "").match(new RegExp(`^${monthPrefix}[ABC](\\d{4})$`));
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);

  for (let sequence = highestSequence + 1; sequence <= 9999; sequence += 1) {
    const bookingId = `${bookingIdPrefix}${String(sequence).padStart(4, "0")}`;
    if (!(await bookingDocumentExists(bookingId))) return bookingId;
  }

  throw new Error("Could not generate a booking ID for this month. Please try again.");
}

function makeVerificationCode() {
  return makeUniqueAlphaNumericCode(5, bookingTokenExists);
}

function makeConfirmationToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// WhatsApp Share Booking: generate the prefilled sharing URL from booking details.
function buildWhatsAppShareUrl(booking) {
  return `https://api.whatsapp.com/send?text=${encodeURIComponent(buildConfirmationMessage(booking))}`;
}

function buildConfirmationMessage(booking) {
  const confirmationUrl = getBookingConfirmationUrl(booking);
  return [
    "Booking Confirmed",
    "",
    `Name: ${booking.name || "-"}`,
    `Mobile: ${booking.phoneNumber || "-"}`,
    `Sport: ${booking.sportName || "-"}`,
    `Court: ${getBookingCourtBadge(booking)}`,
    `Date: ${booking.bookingDateLabel || formatBookingDateOnly(booking.bookingDate)}`,
    `Time: ${booking.timeSlot || `${booking.startTime || "-"} - ${booking.endTime || "-"}`}`,
    `Amount: ${formatCurrency(booking.amount || 0)}`,
    `Booking ID: ${booking.bookingId || "-"}`,
    `Unique Code: ${booking.bookingToken || "-"}`,
    "",
    "Download confirmation:",
    confirmationUrl,
  ].join("\n");
}

function getBookingConfirmationUrl(booking) {
  const token = encodeURIComponent(booking.confirmationToken || booking.bookingToken || "");
  const publicBaseUrl = (window.PADEL_PUBLIC_CONFIG?.baseUrl || window.location.origin).replace(/\/+$/, "");
  return `${publicBaseUrl}/booking-confirm?token=${token}`;
}

function getBookingPdfFileName(booking) {
  return `${booking.bookingId || "booking-confirmation"}.pdf`;
}

function getConfirmationCaptureElement() {
  return $("#confirmationPdfContent") || $(".confirmation-modal");
}

async function createConfirmationPdfBlob(booking) {
  if (!window.html2canvas || !window.jspdf?.jsPDF) {
    throw new Error("PDF generator is still loading. Please try again in a moment.");
  }

  const target = getConfirmationCaptureElement();
  if (!target) throw new Error("Confirmation ticket is not available.");

  target.classList.add("pdf-capture");
  let canvas;
  try {
    canvas = await html2canvas(target, {
      backgroundColor: "#ffffff",
      scale: Math.min(window.devicePixelRatio || 2, 3),
      useCORS: true,
      windowWidth: 900,
    });
  } finally {
    target.classList.remove("pdf-capture");
  }
  const imageData = canvas.toDataURL("image/png");
  const pdf = new window.jspdf.jsPDF({
    orientation: "portrait",
    unit: "pt",
    format: "a4",
  });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 28;
  const imageWidth = pageWidth - margin * 2;
  const imageHeight = (canvas.height * imageWidth) / canvas.width;
  const fittedHeight = Math.min(imageHeight, pageHeight - margin * 2);

  pdf.addImage(imageData, "PNG", margin, margin, imageWidth, fittedHeight);
  return pdf.output("blob");
}

async function downloadConfirmationPdf(booking, button) {
  window.open(getBookingConfirmationUrl(booking), "_blank", "noopener,noreferrer");
}

async function shareConfirmationOnWhatsApp(booking, button) {
  window.open(buildWhatsAppShareUrl(booking), "_blank", "noopener,noreferrer");
}

// Booking Confirmation Messaging: backend endpoints can later send SMS/WhatsApp.
function createMessageServices() {
  const senderNumber = window.PADEL_MESSAGE_CONFIG?.senderNumber || "";

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

function getBookingDurationMinutes(booking = {}) {
  if (Array.isArray(booking.slotIndexes) && booking.slotIndexes.length) return booking.slotIndexes.length * 30;
  if (booking.durationMinutes) return Number(booking.durationMinutes) || 0;
  const match = String(booking.durationLabel || "").match(/([\d.]+)\s*(hour|hr|min)/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return /min/i.test(match[2]) ? value : value * 60;
}

async function fetchBookingsByPhone(phoneNumber) {
  const localMatches = state.allBookings.filter((booking) => booking.phoneNumber === phoneNumber);

  if (firebaseSdkReady) {
    const snapshot = await bookingsRef.where("phoneNumber", "==", phoneNumber).limit(100).get();
    const remoteMatches = snapshot.docs.map((doc) => ({ docId: doc.id, ...doc.data() }));
    const byId = new Map([...localMatches, ...remoteMatches].map((booking) => [booking.docId || booking.bookingId, booking]));
    return Array.from(byId.values());
  }

  if (firebaseRestReady) {
    const matches = await runFirestoreRestCollectionQuery("Bookings", {
      where: {
        fieldFilter: {
          field: { fieldPath: "phoneNumber" },
          op: "EQUAL",
          value: { stringValue: phoneNumber },
        },
      },
      limit: 100,
    });
    const remoteMatches = matches.map((item) => ({
      docId: item.document.name.split("/").pop(),
      ...fromFirestoreFields(item.document.fields || {}),
    }));
    const byId = new Map([...localMatches, ...remoteMatches].map((booking) => [booking.docId || booking.bookingId, booking]));
    return Array.from(byId.values());
  }

  return localMatches;
}

function getBookedMinutesInRange(bookings, start, end) {
  return bookings.reduce((total, booking) => {
    if (booking.status === "Cancelled") return total;
    const bookingDate = timestampToDate(booking.bookingDate);
    if (!bookingDate || Number.isNaN(bookingDate.getTime()) || bookingDate < start || bookingDate >= end) return total;
    return total + getBookingDurationMinutes(booking);
  }, 0);
}

function validateDailyBookingLimit(bookings, selection) {
  const { start, end } = getDayRange(selection.date);
  const bookedMinutes = getBookedMinutesInRange(bookings, start, end);
  const remainingMinutes = Math.max(0, DAILY_BOOKING_LIMIT_MINUTES - bookedMinutes);

  if (selection.durationMinutes <= remainingMinutes) return;

  if (!remainingMinutes) {
    throw new Error("You have reached the daily booking limit of 4 hours. You cannot book more time on this day.");
  }

  throw new Error(
    `You have already booked ${formatDurationHours(bookedMinutes)} on this day. You can book only ${formatDurationHours(
      remainingMinutes,
    )} more on this day. Please reduce your selected time.`,
  );
}

async function validateBookingTimeLimits(phoneNumber, selection) {
  const bookings = await fetchBookingsByPhone(phoneNumber);

  validateDailyBookingLimit(bookings, selection);

  const { start, end } = getWeekRange(selection.date);
  const bookedMinutes = getBookedMinutesInRange(bookings, start, end);
  const remainingMinutes = Math.max(0, WEEKLY_BOOKING_LIMIT_MINUTES - bookedMinutes);

  if (selection.durationMinutes <= remainingMinutes) return;

  if (!remainingMinutes) {
    throw new Error("You have reached the weekly booking limit of 10 hours. You cannot book more time this week.");
  }

  throw new Error(
    `You have already booked ${formatDurationHours(bookedMinutes)} this week. You can book only ${formatDurationHours(
      remainingMinutes,
    )} more this week. Please reduce your selected time.`,
  );
}

// Booking Creation: bookingToken is the visible code; confirmationToken is the private link token.
async function confirmBooking(formData, submitButton) {
  if (isAdminRoute() && !canMutateBookings()) {
    showAlert("Staff can view bookings only.", "error");
    return;
  }

  const mobileDigits = getMobileDigits(formData.get("mobile"));
  const name = formData.get("name").trim();
  const email = formData.get("email").trim();

  if (state.customerLookupLoading) {
    showAlert("Please wait while we check the mobile number.", "info");
    return;
  }
  if (mobileDigits.length !== 10) {
    showAlert("Please enter a valid 10 digit mobile number.", "error");
    elements.bookingForm.elements.mobile.focus();
    return;
  }
  if (!name) {
    showAlert("Please enter customer name.", "error");
    elements.bookingForm.elements.name.focus();
    return;
  }
  if (!isValidOptionalEmail(email)) {
    showAlert("Please enter a valid email address or leave it blank.", "error");
    elements.bookingForm.elements.email.focus();
    return;
  }

  hideBookingLimitModal();
  setButtonLoading(submitButton, true, "Checking...");

  try {
    const selection = getSelection();
    const phoneNumber = `+91${mobileDigits}`;
    await validateBookingTimeLimits(phoneNumber, selection);
    setButtonLoading(submitButton, true, "Saving...");
    const bookingDate = toBookingDate(selection);
    const bookingId = await makeBookingReference(state.selectedSport, bookingDate);
    const bookingToken = await makeVerificationCode();
    const confirmationToken = makeConfirmationToken();
    const players = formData.get("players");
    const customerId = makeCustomerId("", phoneNumber);
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
      confirmationToken,
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
      ...(isAdminRoute() ? { bookingByAdmin: true } : {}),
      ...makeBookingSearchFields({ bookingId, bookingToken, name }),
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
    if (firebaseSdkReady || firebaseRestReady) {
      state.userBookings.unshift({ ...booking, docId: bookingId, createdAt: new Date().toISOString() });
      state.allBookings.unshift({ ...booking, docId: bookingId, createdAt: new Date().toISOString() });
    }

    const smsResult = await messageServices.sms.sendBookingConfirmation(booking).catch((error) => ({ ok: false, error }));
    const whatsappResult = await messageServices.whatsapp.sendBookingConfirmation(booking).catch((error) => ({ ok: false, error }));
    showConfirmation(booking);
    renderUserDashboard();
    renderDates();
    renderAdminDashboard();
    renderAvailability();
    renderAdminCourtBooking();
    // showAlert(
    //   smsResult.ok || whatsappResult.ok
    //     ? "Booking saved and confirmation message queued."
    //     : "Booking saved. Messaging endpoints are not configured yet.",
    //   smsResult.ok || whatsappResult.ok ? "success" : "info",
    // );
  } catch (error) {
    const message = error.message || "Could not create booking. Please try again.";
    if (message.includes("booking limit") || message.includes("this week") || message.includes("this day")) showBookingLimitModal(message);
    else showAlert(message, "error");
  } finally {
    setButtonLoading(submitButton, false);
  }
}

function showConfirmation(booking) {
  if (!elements.confirmationModal || !elements.bookingForm) return;
  renderConfirmationCard(booking);
  $("#downloadButton").onclick = () => downloadConfirmationPdf(booking, $("#downloadButton"));
  $("#whatsappButton").onclick = () => shareConfirmationOnWhatsApp(booking, $("#whatsappButton"));
  elements.detailsModal.hidden = true;
  elements.confirmationModal.hidden = false;
  if (elements.bookingBar) elements.bookingBar.hidden = true;
  elements.bookingForm.reset();
  clearSelection();
}

function closeModal(modal) {
  if (!modal) return;
  if (modal === elements.bookingLimitModal) clearTimeout(state.bookingLimitTimer);
  if (modal === elements.adminUpdateModal) clearTimeout(state.adminUpdateTimer);
  modal.hidden = true;
  if ([elements.detailsModal, elements.bookingLimitModal, elements.confirmationModal, elements.adminBookingModal, elements.adminUpdateModal, elements.authModal, $("#staffModal")].every((item) => !item || item.hidden)) {
    document.body.style.overflow = "";
  }
}

// Authentication System: admin/staff login only; customers book without accounts.
function prepareAuthForm() {
  if (!elements.authForm) return;
  elements.authForm.dataset.mode = "admin";
  if ($("#authTitle")) $("#authTitle").innerHTML = "ADMIN / STAFF<br><em>LOGIN.</em>";
  if ($("#authSubmit")) $("#authSubmit").textContent = "Login";
  if ($("#authNameField")) $("#authNameField").hidden = true;
  if ($("#authPhoneField")) $("#authPhoneField").hidden = true;
  elements.authForm.elements.name.required = false;
  elements.authForm.elements.phoneNumber.required = false;
  if ($("#authToggleText")) $("#authToggleText").textContent = "Admin and staff access only.";
  if ($("#authToggle")) $("#authToggle").hidden = true;
}

function openAuthModal() {
  if (!elements.authModal || !elements.authForm) {
    return;
  }
  prepareAuthForm();
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
      if (!canAccessAdminArea()) throw new Error("Admin or staff access is restricted.");
      updateAuthUI();
      closeModal(elements.authModal);
      navigateToAdmin(true);
      showAlert(`${isStaffProfile() ? "Staff" : "Admin"} logged in successfully.`);
      return;
    }

    const credential = await auth.signInWithEmailAndPassword(elements.authForm.elements.email.value, elements.authForm.elements.password.value);
    state.currentProfile = await loadUserProfile(credential.user);
    if (!canAccessAdminArea()) {
      await auth.signOut();
      state.currentUser = null;
      state.currentProfile = null;
      throw new Error("Admin or staff access is restricted.");
    }
    closeModal(elements.authModal);
    navigateToAdmin(true);
    showAlert(`${isStaffProfile() ? "Staff" : "Admin"} logged in successfully.`);
  } catch (error) {
    if (String(error?.message || "").includes("access is restricted")) {
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
  const hasPanelAccess = canAccessAdminArea();
  if ($("#loginButton")) $("#loginButton").hidden = hasPanelAccess;
  if ($("#registerButton")) $("#registerButton").hidden = true;
  if ($("#logoutButton")) $("#logoutButton").hidden = !loggedIn;
  if ($("#adminPanelButton")) $("#adminPanelButton").hidden = !loggedIn || !hasPanelAccess;
  if ($("#accountName")) {
    $("#accountName").hidden = !loggedIn;
    $("#accountName").textContent = loggedIn ? state.currentProfile?.name || state.currentUser.email : "";
  }
}

function isAdminRoute() {
  const path = window.location.pathname.replace(/\/$/, "");
  return document.body.dataset.page === "admin" || path === "/admin" || path === "/admin.html" || path === "/booking" || path === "/admin-staff";
}

function isStaffRoute() {
  const path = window.location.pathname.replace(/\/$/, "");
  return path === "/admin-staff";
}

function isLoginRoute() {
  const path = window.location.pathname.replace(/\/$/, "");
  return document.body.dataset.page === "login" || path === "/login" || path === "/login.html";
}

function isBookingConfirmationRoute() {
  const path = window.location.pathname.replace(/\/$/, "");
  return document.body.dataset.page === "booking-confirm" || path === "/booking-confirm";
}

function setRoute(path, replace = false) {
  if (window.location.pathname === path) return;
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", path);
}

function showAdminLoginRoute() {
  state.mode = "admin-login";
  if (elements.playerView) elements.playerView.hidden = true;
  if (elements.adminView) elements.adminView.hidden = true;
  if (elements.userDashboard) elements.userDashboard.hidden = true;
  if ($("footer")) $("footer").hidden = true;
  if (elements.bookingBar) elements.bookingBar.hidden = true;
  openAuthModal();
}

function redirectToHome() {
  window.location.replace("/");
}

function redirectToLogin() {
  window.location.replace("/login");
}

// Firestore Booking Snapshot: keep availability live across admin and user tabs.
function subscribeToBookings() {
  if (!firebaseSdkReady) {
    renderAvailability();
    return;
  }

  if (window.unsubscribeAdminBookings) {
    window.unsubscribeAdminBookings();
    window.unsubscribeAdminBookings = null;
  }

  const subscriptionDates = isAdminRoute() ? getAdminCourtDates() : dates;
  const startDate = new Date(subscriptionDates[0]);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(subscriptionDates[subscriptionDates.length - 1]);
  endDate.setHours(23, 59, 59, 999);

  window.unsubscribeAdminBookings = bookingsRef
    .where("bookingDate", ">=", toFirestoreTimestamp(startDate))
    .where("bookingDate", "<=", toFirestoreTimestamp(endDate))
    .limit(1000)
    .onSnapshot((snapshot) => {
      backfillAdminSearchFields(snapshot);
      state.allBookings = snapshot.docs.map((doc) => ({
        docId: doc.id,
        ...doc.data(),
      }));

      renderDates();
      renderAvailability();
      renderAdminCourtBooking();
    }, (error) => {
      console.error(error);
    });
}

function showView(view) {
  state.mode = view;
  if (elements.playerView) elements.playerView.hidden = view !== "player";
  if (elements.adminView) elements.adminView.hidden = view !== "admin";
  if (elements.userDashboard) elements.userDashboard.hidden = view !== "user";
  if ($("footer")) $("footer").hidden = view === "admin" || view === "user" || view === "confirmation";
  if (elements.bookingBar) elements.bookingBar.hidden = true;
  if (view === "player" && window.location.hash) {
    const target = $(window.location.hash);
    if (target) {
      setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      return;
    }
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderRoute({ replace = false, showDenied = false } = {}) {
  if (isBookingConfirmationRoute()) {
    showView("confirmation");
    renderPublicBookingConfirmation();
    return;
  }

  if (isAdminRoute()) {
    if (isStaffRoute() && !canManageStaff()) {
      window.location.assign("/booking");
      if (showDenied) showAlert("Only admins can manage staff.", "error");
      return;
    }

    if (canAccessAdminArea()) {
      showView("admin");
      renderAdminDashboard();
      renderStaffPage();
      updateStaffPermissionsUI();
      return;
    }

    redirectToLogin();
    if (showDenied) showAlert("Admin or staff login is required to access this page.", "error");
    return;
  }

  if (isLoginRoute()) {
    if (canAccessAdminArea()) {
      navigateToAdmin(true);
      return;
    }
    return;
  }

  showView("player");
  if (replace) setRoute("/", true);
}

function navigateToHome(replace = false) {
  if (isAdminRoute()) {
    window.location.assign("/");
    return;
  }

  setRoute("/", replace);
  renderRoute({ replace });
}

function navigateToAdmin(replace = false) {
  if (!isAdminRoute()) {
    window.location.assign("/booking");
    return;
  }

  setRoute("/booking", replace);
  renderRoute();
}

function renderStatusPill(value) {
  const className = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  return `<span class="status-pill ${className}">${value || "Unknown"}</span>`;
}

function renderBookingActions(booking) {
  if (!canMutateBookings()) return `<span class="empty-actions">View only</span>`;

  const id = booking.docId || booking.bookingId;
  const actions = [];

  if (booking.paymentStatus !== "Paid" && booking.status !== "Cancelled") {
    actions.push(["paid", "Paid"]);
  }

  if (booking.status !== "Cancelled") {
    actions.push(["cancelled", "Cancel"]);
  }

  return actions.length
    ? actions.map(([action, label]) => `<button data-action="${action}" data-id="${id}" type="button">${label}</button>`).join("")
    : `<span class="empty-actions">No actions</span>`;
}

function resetAdminBookingPager() {
  state.adminBookingPage = 1;
  state.adminBookingPages = [];
  state.adminBookingQueryKey = "";
  state.adminBookingTotal = 0;
}

function getAdminSearchField(term) {
  const value = term.trim();
  if (/^bk/i.test(value) || /^(?=.*[a-z])(?=.*\d)[a-z0-9]{7}$/i.test(value)) return "bookingIdSearch";
  if (/^(?=.*[a-z])(?=.*\d)[a-z0-9]{5}$/i.test(value)) return "bookingTokenSearch";
  return "nameSearch";
}

function makeBookingSearchFields({ bookingId, bookingToken, name }) {
  return {
    bookingIdSearch: String(bookingId || "").toLowerCase(),
    bookingTokenSearch: String(bookingToken || "").toLowerCase(),
    nameSearch: String(name || "").toLowerCase(),
  };
}

function makePrefixEnd(value) {
  return `${value}\uf8ff`;
}

function getTodayStart() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function getCurrentBookingCutoff() {
  return new Date();
}

function getMonthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function getMonthEnd() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
}

function serializeAdminBooking(bookingDoc) {
  return {
    docId: bookingDoc.id,
    ...bookingDoc.data(),
  };
}

function backfillAdminSearchFields(snapshot) {
  if (!firebaseSdkReady || state.currentProfile?.role !== "admin" || state.adminSearchBackfillDone) return;
  state.adminSearchBackfillDone = true;
  snapshot.docs.forEach((doc) => {
    const booking = doc.data();
    if (booking.bookingIdSearch && booking.bookingTokenSearch && booking.nameSearch) return;
    doc.ref.update(makeBookingSearchFields(booking)).catch((error) => console.warn("Could not backfill booking search fields", error));
  });
}

function getAdminQueryKey() {
  return state.adminBookingSearch.trim().toLowerCase();
}

function matchesAdminBookingSearch(booking, searchTerm) {
  if (!searchTerm) return true;
  return [booking.bookingId, booking.bookingToken, booking.name].some((value) =>
    String(value || "").toLowerCase().includes(searchTerm),
  );
}

function showAdminTableLoading() {
  const table = $("#adminBookingTable");
  if (!table) return;
  table.innerHTML = `<tr><td colspan="8"><p class="empty-state">Loading bookings...</p></td></tr>`;
}

async function getFirestoreQueryCount(query) {
  if (typeof query.count === "function") {
    const snapshot = await query.count().get();
    return snapshot.data().count;
  }

  const snapshot = await query.get();
  return snapshot.size;
}

async function fetchAdminBookingTotal() {
  const queryKey = getAdminQueryKey();

  if (queryKey) {
    const field = getAdminSearchField(queryKey);
    return getFirestoreQueryCount(bookingsRef.orderBy(field).startAt(queryKey).endAt(makePrefixEnd(queryKey)));
  }

  const cutoff = toFirestoreTimestamp(getCurrentBookingCutoff());
  const [upcomingCount, pastCount] = await Promise.all([
    getFirestoreQueryCount(bookingsRef.where("bookingDate", ">=", cutoff).orderBy("bookingDate", "asc")),
    getFirestoreQueryCount(bookingsRef.where("bookingDate", "<", cutoff).orderBy("bookingDate", "desc")),
  ]);
  return upcomingCount + pastCount;
}

async function fetchAdminRevenueForRange(startDate, endDate) {
  const snapshot = await bookingsRef
    .where("bookingDate", ">=", toFirestoreTimestamp(startDate))
    .where("bookingDate", "<=", toFirestoreTimestamp(endDate))
    .get();

  return snapshot.docs
    .map((doc) => doc.data())
    .filter((booking) => booking.status !== "Cancelled")
    .reduce((total, booking) => total + Number(booking.amount || 0), 0);
}

async function fetchAdminMetrics(bookings) {
  if (!firebaseSdkReady) {
    const today = new Date();
    const activeBookings = bookings.filter((booking) => booking.status !== "Cancelled");
    return [
      ["Total Bookings", bookings.length],
      ["Checked-In Bookings", bookings.filter((booking) => booking.status === "Checked-In").length],
      ["Cancelled Bookings", bookings.filter((booking) => booking.status === "Cancelled").length],
      ["Paid Bookings", bookings.filter((booking) => booking.paymentStatus === "Paid").length],
      ["Unpaid Bookings", bookings.filter((booking) => booking.paymentStatus === "Unpaid").length],
      [
        "Expected Revenue Today",
        formatCurrency(
          activeBookings
            .filter((booking) => timestampToDate(booking.bookingDate)?.toDateString() === today.toDateString())
            .reduce((total, booking) => total + Number(booking.amount || 0), 0),
        ),
      ],
      [
        "Expected Revenue This Month",
        formatCurrency(
          activeBookings
            .filter((booking) => {
              const bookingDate = timestampToDate(booking.bookingDate);
              return bookingDate && bookingDate.getMonth() === today.getMonth() && bookingDate.getFullYear() === today.getFullYear();
            })
            .reduce((total, booking) => total + Number(booking.amount || 0), 0),
        ),
      ],
    ];
  }

  const todayStart = getTodayStart();
  const todayEnd = new Date(todayStart);
  todayEnd.setHours(23, 59, 59, 999);
  const [total, checkedIn, cancelled, paid, unpaid, expectedToday, expectedMonth] = await Promise.all([
    getFirestoreQueryCount(bookingsRef),
    getFirestoreQueryCount(bookingsRef.where("status", "==", "Checked-In")),
    getFirestoreQueryCount(bookingsRef.where("status", "==", "Cancelled")),
    getFirestoreQueryCount(bookingsRef.where("paymentStatus", "==", "Paid")),
    getFirestoreQueryCount(bookingsRef.where("paymentStatus", "==", "Unpaid")),
    fetchAdminRevenueForRange(todayStart, todayEnd),
    fetchAdminRevenueForRange(getMonthStart(), getMonthEnd()),
  ]);

  return [
    ["Total Bookings", total],
    ["Checked-In Bookings", checkedIn],
    ["Cancelled Bookings", cancelled],
    ["Paid Bookings", paid],
    ["Unpaid Bookings", unpaid],
    ["Expected Revenue Today", formatCurrency(expectedToday)],
    ["Expected Revenue This Month", formatCurrency(expectedMonth)],
  ];
}

function renderAdminPaginationControls(totalItems) {
  const pagination = $("#adminBookingPagination");
  if (!pagination) return;

  const totalPages = Math.max(1, Math.ceil(totalItems / ADMIN_BOOKINGS_PAGE_SIZE));
  state.adminBookingPage = Math.min(Math.max(state.adminBookingPage, 1), totalPages);
  const pageStart = totalItems ? (state.adminBookingPage - 1) * ADMIN_BOOKINGS_PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(state.adminBookingPage * ADMIN_BOOKINGS_PAGE_SIZE, totalItems);

  if (!totalItems) {
    pagination.innerHTML = "";
    pagination.hidden = true;
    return;
  }

  pagination.hidden = false;
  const pageButtons = getPaginationPages(state.adminBookingPage, totalPages)
    .map((page) =>
      page === "..."
        ? `<span class="pagination-ellipsis">...</span>`
        : `<button class="${page === state.adminBookingPage ? "active" : ""}" data-page="${page}" type="button">${page}</button>`,
    )
    .join("");

  pagination.innerHTML = `
    <span class="pagination-summary">Showing ${pageStart}-${pageEnd} of ${totalItems} bookings</span>
    <div class="pagination-controls">
      <button data-page="${state.adminBookingPage - 1}" type="button" ${state.adminBookingPage === 1 ? "disabled" : ""}>Prev</button>
      ${pageButtons}
      <button data-page="${state.adminBookingPage + 1}" type="button" ${state.adminBookingPage === totalPages ? "disabled" : ""}>Next</button>
    </div>
  `;

  $$("#adminBookingPagination [data-page]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.adminBookingPage = Number(button.dataset.page);
      await renderAdminDashboard({ showLoading: true });
    });
  });
}

async function fetchAdminSearchPage(previousPage) {
  const queryKey = getAdminQueryKey();
  const field = getAdminSearchField(queryKey);
  let query = bookingsRef.orderBy(field).startAt(queryKey).endAt(makePrefixEnd(queryKey)).limit(ADMIN_BOOKINGS_PAGE_SIZE + 1);
  if (previousPage?.lastDoc) query = query.startAfter(previousPage.lastDoc);

  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, ADMIN_BOOKINGS_PAGE_SIZE);
  return {
    rows: docs.map(serializeAdminBooking),
    lastDoc: docs[docs.length - 1] || previousPage?.lastDoc || null,
    hasNextPage: snapshot.docs.length > ADMIN_BOOKINGS_PAGE_SIZE,
    mode: "search",
  };
}

async function fetchAdminChronologicalPage(previousPage) {
  let rows = [];
  let upcomingCursor = previousPage?.upcomingCursor || null;
  let pastCursor = previousPage?.pastCursor || null;
  let mode = previousPage?.mode || "upcoming";
  let hasNextPage = false;
  const cutoff = toFirestoreTimestamp(getCurrentBookingCutoff());

  if (mode === "upcoming") {
    let upcomingQuery = bookingsRef
      .where("bookingDate", ">=", cutoff)
      .orderBy("bookingDate", "asc")
      .limit(ADMIN_BOOKINGS_PAGE_SIZE + 1);
    if (upcomingCursor) upcomingQuery = upcomingQuery.startAfter(upcomingCursor);

    const upcomingSnapshot = await upcomingQuery.get();
    const upcomingDocs = upcomingSnapshot.docs.slice(0, ADMIN_BOOKINGS_PAGE_SIZE);
    rows = upcomingDocs.map(serializeAdminBooking);
    upcomingCursor = upcomingDocs[upcomingDocs.length - 1] || upcomingCursor;
    hasNextPage = upcomingSnapshot.docs.length > ADMIN_BOOKINGS_PAGE_SIZE;

    if (!hasNextPage && rows.length < ADMIN_BOOKINGS_PAGE_SIZE) {
      mode = "past";
    }
  }

  if (mode === "past" && rows.length < ADMIN_BOOKINGS_PAGE_SIZE) {
    const remaining = ADMIN_BOOKINGS_PAGE_SIZE - rows.length;
    let pastQuery = bookingsRef
      .where("bookingDate", "<", cutoff)
      .orderBy("bookingDate", "desc")
      .limit(remaining + 1);
    if (pastCursor) pastQuery = pastQuery.startAfter(pastCursor);

    const pastSnapshot = await pastQuery.get();
    const pastDocs = pastSnapshot.docs.slice(0, remaining);
    rows = [...rows, ...pastDocs.map(serializeAdminBooking)];
    pastCursor = pastDocs[pastDocs.length - 1] || pastCursor;
    hasNextPage = pastSnapshot.docs.length > remaining;
  }

  return { rows, upcomingCursor, pastCursor, hasNextPage, mode };
}

async function ensureAdminFirestorePage(pageNumber) {
  const queryKey = getAdminQueryKey();
  if (state.adminBookingQueryKey !== queryKey) {
    state.adminBookingPages = [];
    state.adminBookingQueryKey = queryKey;
  }

  while (state.adminBookingPages.length < pageNumber) {
    const previousPage = state.adminBookingPages[state.adminBookingPages.length - 1];
    if (previousPage && !previousPage.hasNextPage) break;
    const nextPage = queryKey ? await fetchAdminSearchPage(previousPage) : await fetchAdminChronologicalPage(previousPage);
    if (!nextPage.rows.length) {
      if (state.adminBookingPages.length === 0) state.adminBookingPages.push(nextPage);
      break;
    }
    state.adminBookingPages.push(nextPage);
  }

  return state.adminBookingPages[pageNumber - 1] || { rows: [], hasNextPage: false };
}

function getBookingSortDate(booking) {
  const bookingDate = timestampToDate(booking.bookingDate);
  if (bookingDate && !Number.isNaN(bookingDate.getTime())) return bookingDate;
  const createdDate = timestampToDate(booking.createdAt);
  return createdDate && !Number.isNaN(createdDate.getTime()) ? createdDate : new Date(0);
}

function isPastBooking(booking) {
  const bookingDate = getBookingSortDate(booking);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return bookingDate < today;
}

function sortAdminBookings(bookings) {
  return [...bookings].sort((a, b) => {
    const aPast = isPastBooking(a);
    const bPast = isPastBooking(b);
    if (aPast !== bPast) return aPast ? 1 : -1;

    const aTime = getBookingSortDate(a).getTime();
    const bTime = getBookingSortDate(b).getTime();
    return aPast ? bTime - aTime : aTime - bTime;
  });
}

function getPaginationPages(currentPage, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);

  const pages = [1];
  const start = Math.max(2, currentPage - 1);
  const end = Math.min(totalPages - 1, currentPage + 1);

  if (start > 2) pages.push("...");
  for (let page = start; page <= end; page += 1) pages.push(page);
  if (end < totalPages - 1) pages.push("...");
  pages.push(totalPages);
  return pages;
}

function renderAdminPagination(totalItems) {
  const pagination = $("#adminBookingPagination");
  if (!pagination) return;

  const totalPages = Math.max(1, Math.ceil(totalItems / ADMIN_BOOKINGS_PAGE_SIZE));
  state.adminBookingPage = Math.min(Math.max(state.adminBookingPage, 1), totalPages);
  const pageStart = totalItems ? (state.adminBookingPage - 1) * ADMIN_BOOKINGS_PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(state.adminBookingPage * ADMIN_BOOKINGS_PAGE_SIZE, totalItems);

  if (!totalItems) {
    pagination.innerHTML = "";
    pagination.hidden = true;
    return;
  }

  pagination.hidden = false;
  const pageButtons = getPaginationPages(state.adminBookingPage, totalPages)
    .map((page) =>
      page === "..."
        ? `<span class="pagination-ellipsis">...</span>`
        : `<button class="${page === state.adminBookingPage ? "active" : ""}" data-page="${page}" type="button">${page}</button>`,
    )
    .join("");

  pagination.innerHTML = `
    <span class="pagination-summary">Showing ${pageStart}-${pageEnd} of ${totalItems} bookings</span>
    <div class="pagination-controls">
      <button data-page="${state.adminBookingPage - 1}" type="button" ${state.adminBookingPage === 1 ? "disabled" : ""}>Prev</button>
      ${pageButtons}
      <button data-page="${state.adminBookingPage + 1}" type="button" ${state.adminBookingPage === totalPages ? "disabled" : ""}>Next</button>
    </div>
  `;

  $$("#adminBookingPagination [data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      state.adminBookingPage = Number(button.dataset.page);
      renderAdminDashboard({ showLoading: true });
    });
  });
}

function renderAdminGreeting() {
  const dateElement = $("#adminCurrentDate");
  const greetingElement = $("#adminGreeting");
  if (!dateElement || !greetingElement) return;

  const now = new Date();
  const hour = now.getHours();
  dateElement.textContent = now.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
  greetingElement.textContent = hour < 12 ? "Good morning." : hour < 17 ? "Good afternoon." : "Good evening.";
}

// User Dashboard: profile, history, status, payment state, and share action.
function renderUserDashboard() {
  if (!$("#userProfileCard") || !$("#userBookingsList")) return;
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
async function renderAdminDashboard({ showLoading = false } = {}) {
  const metricsElement = $("#adminMetrics");
  const bookingTable = $("#adminBookingTable");
  if (!metricsElement) return;
  const bookings = state.allBookings;
  const searchTerm = state.adminBookingSearch.trim().toLowerCase();
  const filteredBookings = searchTerm
    ? bookings.filter((booking) => matchesAdminBookingSearch(booking, searchTerm))
    : bookings;
  const metricRows = await fetchAdminMetrics(bookings);

  metricsElement.innerHTML = metricRows
    .map(
      ([label, value]) => `
      <article><div><span>${label}</span></div><strong>${value}</strong><small>Live from Firestore</small></article>
    `,
    )
    .join("");

  renderAdminCourtBooking();

  if (!bookingTable) return;

  let visibleBookings = [];
  let totalItems = filteredBookings.length;

  if (firebaseSdkReady) {
    const requestId = ++state.adminBookingRequestId;
    state.adminBookingLoading = true;
    if (showLoading) showAdminTableLoading();

    try {
      const latestTotal = await fetchAdminBookingTotal();
      if (state.adminBookingTotal !== latestTotal) {
        state.adminBookingPages = [];
        state.adminBookingTotal = latestTotal;
      }
      totalItems = state.adminBookingTotal;
      const totalPages = Math.max(1, Math.ceil(totalItems / ADMIN_BOOKINGS_PAGE_SIZE));
      state.adminBookingPage = Math.min(Math.max(state.adminBookingPage, 1), totalPages);
      const page = await ensureAdminFirestorePage(state.adminBookingPage);
      if (requestId !== state.adminBookingRequestId) return;
      if (!page.rows.length && state.adminBookingPage > 1) {
        state.adminBookingPage = Math.max(1, state.adminBookingPages.length);
        const fallbackPage = state.adminBookingPages[state.adminBookingPage - 1] || { rows: [], hasNextPage: false };
        visibleBookings = fallbackPage.rows;
      } else {
      visibleBookings = page.rows;
      }
      const expectedRowsOnPage = Math.max(0, Math.min(ADMIN_BOOKINGS_PAGE_SIZE, totalItems - (state.adminBookingPage - 1) * ADMIN_BOOKINGS_PAGE_SIZE));
      visibleBookings = visibleBookings.slice(0, expectedRowsOnPage);
    } catch (error) {
      if (requestId !== state.adminBookingRequestId) return;
      bookingTable.innerHTML = `<tr><td colspan="8"><p class="empty-state">${error.message || "Could not load bookings."}</p></td></tr>`;
      renderAdminPaginationControls(0);
      return;
    } finally {
      if (requestId === state.adminBookingRequestId) state.adminBookingLoading = false;
    }
  } else {
    const sortedBookings = sortAdminBookings(filteredBookings);
    const totalPages = Math.max(1, Math.ceil(sortedBookings.length / ADMIN_BOOKINGS_PAGE_SIZE));
    state.adminBookingPage = Math.min(Math.max(state.adminBookingPage, 1), totalPages);
    const pageStart = (state.adminBookingPage - 1) * ADMIN_BOOKINGS_PAGE_SIZE;
    visibleBookings = sortedBookings.slice(pageStart, pageStart + ADMIN_BOOKINGS_PAGE_SIZE);
    totalItems = sortedBookings.length;
  }

  bookingTable.innerHTML = visibleBookings.length
    ? visibleBookings
        .map(
          (booking) => `
      <tr>
        <td>${booking.bookingId}</td>
        <td>${booking.bookingToken}</td>
        <td>
          <div class="table-detail-stack">
            <strong>${booking.sportName || "-"}</strong>
            <span>${booking.courtName || booking.facilityName || "-"}</span>
          </div>
        </td>
        <td>
          <div class="table-detail-stack">
            <strong>${booking.name || "-"}</strong>
            <span>${booking.phoneNumber || "-"}</span>
            <span>${booking.email || "-"}</span>
          </div>
        </td>
        <td>${formatBookingDate(booking.bookingDate)}</td>
        <td>${renderStatusPill(booking.status)}</td>
        <td>${renderStatusPill(booking.paymentStatus)}</td>
        <td>
          <div class="table-actions">
            ${renderBookingActions(booking)}
          </div>
        </td>
      </tr>
    `,
        )
        .join("")
    : `<tr><td colspan="8"><p class="empty-state">No bookings found.</p></td></tr>`;

  if (firebaseSdkReady) renderAdminPaginationControls(totalItems);
  else renderAdminPagination(totalItems);

  $$("#adminBookingTable [data-action]").forEach((button) => {
    button.addEventListener("click", () => updateBookingFromAdmin(button.dataset.id, button.dataset.action, button));
  });
}

async function updateBookingFromAdmin(docId, action, button) {
  if (!canMutateBookings()) {
    showAlert("Only admins can update bookings.", "error");
    return;
  }

  const updates = action === "paid" ? { paymentStatus: "Paid" } : { status: "Cancelled" };

  setButtonLoading(button, true, "Saving...");
  try {
    if (firebaseSdkReady) {
      await bookingsRef.doc(docId).update(updates);
      state.allBookings = state.allBookings.map((booking) => ((booking.docId || booking.bookingId) === docId ? { ...booking, ...updates } : booking));
      state.userBookings = state.userBookings.map((booking) => ((booking.docId || booking.bookingId) === docId ? { ...booking, ...updates } : booking));
      resetAdminBookingPager();
      renderDates();
      renderAdminCourtBooking();
      await renderAdminDashboard({ showLoading: true });
    } else {
      state.allBookings = state.allBookings.map((booking) => (booking.bookingId === docId ? { ...booking, ...updates } : booking));
      state.userBookings = state.userBookings.map((booking) => (booking.bookingId === docId ? { ...booking, ...updates } : booking));
      renderDates();
      renderAdminCourtBooking();
      renderAdminDashboard();
      renderUserDashboard();
    }
    showAdminUpdateModal("Booking updated.");
  } catch (error) {
    showAlert(error.message || "Could not update booking.", "error");
  } finally {
    setButtonLoading(button, false);
  }
}

function updateStaffPermissionsUI() {
  const adminOnlyElements = $$("[data-admin-only]");
  adminOnlyElements.forEach((element) => {
    element.hidden = !canManageStaff();
  });
  if ($("#newBookingButton")) $("#newBookingButton").hidden = !canMutateBookings();
  if ($("#continueButton")) $("#continueButton").disabled = !canMutateBookings();
}

async function createStaffAuthUser(email, password) {
  if (!hasFirebaseConfig) throw new Error("Firebase config is required to create staff.");
  const signup = await firebaseRestRequest(`${FIREBASE_AUTH_BASE_URL}/accounts:signUp?key=${firebaseConfig.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  return { uid: signup.localId, email: signup.email || email, idToken: signup.idToken };
}

async function loadStaffMembers() {
  if (!firebaseSdkReady || !canManageStaff()) return [];
  state.staffLoading = true;
  const snapshot = await usersRef.where("role", "==", "staff").get();
  state.staffMembers = snapshot.docs.map((doc) => ({ uid: doc.id, ...doc.data() }));
  state.staffLoading = false;
  return state.staffMembers;
}

function renderStaffRows() {
  const table = $("#adminStaffTable");
  if (!table) return;

  table.innerHTML = state.staffMembers.length
    ? state.staffMembers
        .map(
          (staff) => `
      <tr>
        <td>${staff.name || "-"}</td>
        <td>${staff.email || "-"}</td>
        <td>${renderStatusPill(staff.role || "staff")}</td>
        <td>${formatBookingDate(staff.createdAt)}</td>
        <td>
          <div class="table-actions">
            <button data-staff-edit="${staff.uid}" type="button">Edit</button>
            <button data-staff-delete="${staff.uid}" type="button">Delete</button>
          </div>
        </td>
      </tr>
    `,
        )
        .join("")
    : `<tr><td colspan="5"><p class="empty-state">No staff created yet.</p></td></tr>`;

  $$("[data-staff-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const staff = state.staffMembers.find((item) => item.uid === button.dataset.staffEdit);
      if (staff) openStaffModal(staff);
    });
  });
  $$("[data-staff-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteStaffMember(button.dataset.staffDelete, button));
  });
}

async function renderStaffPage() {
  const table = $("#adminStaffTable");
  if (!table) return;
  if (!canManageStaff()) {
    table.innerHTML = `<tr><td colspan="5"><p class="empty-state">Only admins can manage staff.</p></td></tr>`;
    return;
  }
  table.innerHTML = `<tr><td colspan="5"><p class="empty-state">Loading staff...</p></td></tr>`;
  try {
    await loadStaffMembers();
    renderStaffRows();
  } catch (error) {
    table.innerHTML = `<tr><td colspan="5"><p class="empty-state">${error.message || "Could not load staff."}</p></td></tr>`;
  }
}

function openStaffModal(staff = null) {
  const modal = $("#staffModal");
  const form = $("#staffForm");
  if (!modal || !form || !canManageStaff()) return;

  state.editingStaffId = staff?.uid || "";
  form.reset();
  form.elements.uid.value = staff?.uid || "";
  form.elements.name.value = staff?.name || "";
  form.elements.email.value = staff?.email || "";
  form.elements.email.readOnly = Boolean(staff);
  form.elements.password.required = !staff;
  $("#staffPasswordField").hidden = Boolean(staff);
  if ($("#staffModalTitle")) $("#staffModalTitle").innerHTML = staff ? "EDIT<br /><em>STAFF.</em>" : "CREATE<br /><em>STAFF.</em>";
  if ($("#staffSubmit")) $("#staffSubmit").innerHTML = staff ? "Update staff <span>&rarr;</span>" : "Save staff <span>&rarr;</span>";
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

async function saveStaffMember(event) {
  event.preventDefault();
  if (!canManageStaff()) {
    showAlert("Only admins can manage staff.", "error");
    return;
  }

  const form = event.currentTarget;
  const submitButton = $("#staffSubmit");
  const uid = form.elements.uid.value;
  const name = form.elements.name.value.trim();
  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;

  if (!name || !email || (!uid && password.length < 6)) {
    showAlert("Please enter valid staff details.", "error");
    return;
  }

  setButtonLoading(submitButton, true, uid ? "Updating..." : "Creating...");
  try {
    const now = firebase.firestore.FieldValue.serverTimestamp();
    if (uid) {
      await usersRef.doc(uid).set({ uid, name, role: "staff", updatedAt: now }, { merge: true });
      showAlert("Staff updated.");
    } else {
      const staffUser = await createStaffAuthUser(email, password);
      await setFirestoreRestDocument(
        "Users",
        staffUser.uid,
        {
          uid: staffUser.uid,
          name,
          email: staffUser.email,
          phoneNumber: "",
          role: "user",
          createdAt: new Date().toISOString(),
        },
        staffUser.idToken,
      );
      await usersRef.doc(staffUser.uid).set({
        uid: staffUser.uid,
        name,
        email: staffUser.email,
        phoneNumber: "",
        role: "staff",
        createdAt: now,
        updatedAt: now,
      });
      showAlert("Staff created.");
    }
    closeModal($("#staffModal"));
    await renderStaffPage();
  } catch (error) {
    showAlert(getFirebaseErrorMessage(error), "error");
  } finally {
    setButtonLoading(submitButton, false);
  }
}

async function deleteStaffMember(uid, button) {
  if (!canManageStaff()) {
    showAlert("Only admins can manage staff.", "error");
    return;
  }
  if (!window.confirm("Delete this staff account access?")) return;

  setButtonLoading(button, true, "Deleting...");
  try {
    await usersRef.doc(uid).delete();
    state.staffMembers = state.staffMembers.filter((staff) => staff.uid !== uid);
    renderStaffRows();
    showAlert("Staff deleted.");
  } catch (error) {
    showAlert(error.message || "Could not delete staff.", "error");
  } finally {
    setButtonLoading(button, false);
  }
}

// Admin Route Protection: block non-admins from rendering the admin panel.
function protectAdminRoute() {
  if (!canAccessAdminArea()) {
    navigateToHome(true);
    showAlert("Admin or staff access is restricted.", "error");
    return false;
  }
  return true;
}

function setAdminSidebarOpen(open) {
  document.body.classList.toggle("admin-sidebar-open", open);
  const menuButtons = [$("#adminMenuButton"), $("#adminHeaderMenuButton")].filter(Boolean);
  const backdrop = $("#adminSidebarBackdrop");
  menuButtons.forEach((button) => button.setAttribute("aria-expanded", String(open)));
  if (backdrop) backdrop.hidden = !open;
}

async function logoutCurrentUser() {
  if (firebaseSdkReady) await auth.signOut();
  state.currentUser = null;
  state.currentProfile = null;
  state.userBookings = [];
  setAdminSidebarOpen(false);
  updateAuthUI();
  navigateToHome(true);
  showAlert("Logged out.");
}

function togglePasswordInput(button) {
  const input = button.closest(".password-input-wrap")?.querySelector("input");
  if (!input) return;
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  button.classList.toggle("is-visible", !showing);
  button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
}

function bindEvents() {
  elements.adminBookingModal = $("#adminBookingModal");
  prepareAuthForm();
  $("#continueButton")?.addEventListener("click", showDetailsModal);
  $("#newBookingButton")?.addEventListener("click", () => {
    if (!canMutateBookings()) {
      showAlert("Staff can view bookings only.", "error");
      return;
    }
    navigateToHome();
    setTimeout(() => $("#book")?.scrollIntoView({ behavior: "smooth" }), 100);
  });
  $("#addStaffButton")?.addEventListener("click", () => openStaffModal());
  $("#staffForm")?.addEventListener("submit", saveStaffMember);
  $$("[data-password-toggle]").forEach((button) => {
    button.addEventListener("click", () => togglePasswordInput(button));
  });
  $("#loginButton")?.addEventListener("click", () => openAuthModal());
  $("#adminPanelButton")?.addEventListener("click", () => {
    if (protectAdminRoute()) navigateToAdmin();
  });
  $("#bookingRulesButton")?.addEventListener("click", () => {
    const modal = $("#bookingRulesModal");
    if (modal) modal.hidden = false;
  });
  $("#adminBookingSearch")?.addEventListener("input", (event) => {
    state.adminBookingSearch = event.target.value;
    resetAdminBookingPager();
    renderAdminDashboard();
  });
  $("#bookingStateToggle")?.addEventListener("click", (event) => {
    const isOpen = document.body.classList.toggle("states-open");
    event.currentTarget.textContent = isOpen ? "Hide" : "Show State";
    event.currentTarget.setAttribute("aria-expanded", String(isOpen));
  });
  $("#adminMenuButton")?.addEventListener("click", () => setAdminSidebarOpen(!document.body.classList.contains("admin-sidebar-open")));
  $("#adminHeaderMenuButton")?.addEventListener("click", () => setAdminSidebarOpen(!document.body.classList.contains("admin-sidebar-open")));
  $("#adminSidebarBackdrop")?.addEventListener("click", () => setAdminSidebarOpen(false));
  $$("#adminSidebar [data-admin-nav]").forEach((link) => link.addEventListener("click", () => setAdminSidebarOpen(false)));
  $("#logoutButton")?.addEventListener("click", logoutCurrentUser);
  $("#adminSidebarLogout")?.addEventListener("click", logoutCurrentUser);
  elements.authForm?.addEventListener("submit", handleAuthSubmit);
  $$(".modal-close, [data-close]").forEach((button) => {
    button.addEventListener("click", () => closeModal($(`#${button.dataset.close}`)));
  });
  [elements.detailsModal, elements.bookingLimitModal, elements.confirmationModal, elements.adminBookingModal, elements.adminUpdateModal, elements.authModal, $("#bookingRulesModal"), $("#staffModal")].filter(Boolean).forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal);
    });
  });
  elements.bookingForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    confirmBooking(new FormData(elements.bookingForm), event.submitter);
  });
  elements.bookingForm?.elements.mobile?.addEventListener("input", handleBookingMobileInput);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideAppMessageModal();
      [elements.confirmationModal, elements.bookingLimitModal, elements.detailsModal, elements.adminBookingModal, elements.adminUpdateModal, elements.authModal, $("#bookingRulesModal"), $("#staffModal")].filter(Boolean).forEach((modal) => {
        if (!modal.hidden) closeModal(modal);
      });
    }
  });
  window.addEventListener("popstate", () => renderRoute({ showDenied: true }));
}

async function bootAuth() {
  if (!firebaseReady) {
    updateAuthUI();
    subscribeToBookings();
    renderUserDashboard();
    renderAdminDashboard();
    renderRoute({ showDenied: isAdminRoute() });
    return;
  }

  if (firebaseRestReady) {
    updateAuthUI();
    renderUserDashboard();
    subscribeToBookings();
    renderAdminDashboard();
    renderRoute({ showDenied: isAdminRoute() });
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
      if (!canAccessAdminArea()) {
        await auth.signOut();
        state.currentUser = null;
        state.currentProfile = null;
        showAlert("Admin or staff access is restricted.", "error");
        return;
      }
      updateAuthUI();
      subscribeToBookings();
      renderRoute();
    } else {
      updateAuthUI();
      if (isAdminRoute()) {
        renderRoute({ showDenied: true });
      } else {
        renderRoute();
      }
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
renderAdminGreeting();
bindEvents();
bootAuth();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
