if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(function (err) {
    console.error("Error registering MapVX service worker:", err);
  });
}