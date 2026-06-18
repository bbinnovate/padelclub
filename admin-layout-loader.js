(function () {
  const APP_SCRIPTS = [
    "https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js",
    "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore-compat.js",
    "/config.js?v=guest-booking-3",
    "/messaging-service.js?v=guest-booking-3",
    "/app.js?v=guest-booking-18",
  ];

  function loadScript(src) {
    return new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = resolve;
      document.body.appendChild(script);
    });
  }

  function loadAppScripts() {
    return APP_SCRIPTS.reduce((chain, src) => chain.then(() => loadScript(src)), Promise.resolve());
  }

  function renderLayout(html) {
    const pageTemplate = document.getElementById("adminPageContent");
    const pageContent = pageTemplate ? pageTemplate.innerHTML : "";
    document.body.insertAdjacentHTML("afterbegin", html);

    const slot = document.getElementById("adminPageSlot");
    if (slot) slot.innerHTML = pageContent;

    const activePage = document.body.dataset.adminActive || "overview";
    document.querySelectorAll("[data-admin-nav]").forEach((link) => {
      link.classList.toggle("active", link.dataset.adminNav === activePage);
    });
  }

  fetch("/admin-layout")
    .then((response) => {
      if (!response.ok) throw new Error("Could not load admin layout.");
      return response.text();
    })
    .then((html) => {
      renderLayout(html);
      return loadAppScripts();
    })
    .catch((error) => {
      document.body.innerHTML = `<p class="empty-state">${error.message}</p>`;
    });
})();
