// Service layer for booking confirmation SMS and WhatsApp delivery.
// Provider credentials belong in backend functions, never in the browser.
window.PadelMessagingService = {
  senderNumber: "8879961503",

  buildConfirmationMessage(booking, formatCurrency, formatBookingDate) {
    return [
      "Padel Club booking confirmation",
      `Booking ID: ${booking.bookingId}`,
      `Booking Token: ${booking.bookingToken}`,
      `Name: ${booking.name}`,
      `Email: ${booking.email}`,
      `Phone: ${booking.phoneNumber}`,
      `${booking.sportName} - ${booking.facilityName}`,
      `${formatBookingDate(booking.bookingDate)} - ${booking.startTime} to ${booking.endTime}`,
      `Amount due: ${formatCurrency(booking.amount)}`,
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
