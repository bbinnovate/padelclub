function sendRuntimeConfig(_, response) {
  const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
    appId: process.env.FIREBASE_APP_ID || "",
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || "",
  };
  const messageConfig = {
    smsEndpoint: process.env.SMS_CONFIRMATION_ENDPOINT || "",
    whatsAppEndpoint: process.env.WHATSAPP_CONFIRMATION_ENDPOINT || "",
    senderNumber: process.env.MESSAGE_SENDER_NUMBER || "",
  };

  response.setHeader("Content-Type", "application/javascript; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.status(200).send(
    [
      `window.PADEL_FIREBASE_CONFIG = ${JSON.stringify(firebaseConfig)};`,
      `window.PADEL_MESSAGE_CONFIG = ${JSON.stringify(messageConfig)};`,
    ].join("\n"),
  );
}

module.exports = sendRuntimeConfig;

