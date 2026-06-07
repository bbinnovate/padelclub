// Service layer for booking confirmation SMS and WhatsApp delivery.
// Provider credentials belong in backend functions, never in the browser.
window.PadelMessagingService = {
  get senderNumber() {
    return window.PADEL_MESSAGE_CONFIG?.senderNumber || "";
  },

  buildConfirmationMessage(booking, formatCurrency, formatBookingDate) {
    return [
      "Booking Confirmed",
      "",
      `Name: ${booking.name}`,
      `Phone: ${booking.phoneNumber}`,
      `Email: ${booking.email}`,
      `Sport: ${booking.sportName}`,
      `Court: ${booking.courtName || booking.facilityName}`,
      `Date: ${booking.bookingDateLabel || formatBookingDate(booking.bookingDate)}`,
      `Time: ${booking.timeSlot || `${booking.startTime} - ${booking.endTime}`}`,
      `Booking ID: ${booking.bookingId}`,
      `Booking Token: ${booking.bookingToken}`,
    ].join("\n");
  },

  async sendSmsConfirmation(booking, message) {
    if (!window.PADEL_MESSAGE_CONFIG?.smsEndpoint) {
      return { ok: false, skipped: true, message: "SMS endpoint is not configured." };
    }
    const response = await fetch(window.PADEL_MESSAGE_CONFIG.smsEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.senderNumber,
        to: booking.phoneNumber,
        message,
      }),
    });
    return { ok: response.ok };
  },

  async sendWhatsAppConfirmation(booking, message) {
    if (!window.PADEL_MESSAGE_CONFIG?.whatsAppEndpoint) {
      return { ok: false, skipped: true, message: "WhatsApp endpoint is not configured." };
    }
    const response = await fetch(window.PADEL_MESSAGE_CONFIG.whatsAppEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.senderNumber,
        to: booking.phoneNumber,
        message,
      }),
    });
    return { ok: response.ok };
  },
};
