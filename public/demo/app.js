/* Legacy static demo entry — redirects into the main SPA login. */
(function () {
  var target = "/";
  try {
    if (location.port === "8765") target = "http://127.0.0.1:5173/";
  } catch (e) {}
  location.replace(target);
})();
