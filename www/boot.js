// 界面热更新的壳：跟着 App 装在手机里，自己不更新（2026-10-13）。
// 界面（index.html 的正文、style.css、app.js）可以从服务器 /app/bundle 下载新版存在 localStorage（app.js 的 checkUi 管下载），
// 这里在启动时决定用哪份：有下载好的就用它，没有就用装在 App 里的。
// 回滚：用下载版启动前记下 ui_booting，app.js 跑完最后一行（uiBootOk）才清掉；
// 下次启动发现还记着 = 上次那版没跑起来 → 扔掉、记进 ui_bad（不再下载这一版），退回装在 App 里的。
(function () {
  var b = null;
  try {
    b = JSON.parse(localStorage.getItem("ui_bundle") || "null");
    if (b && localStorage.getItem("ui_booting") === b.v) {
      localStorage.removeItem("ui_bundle");
      localStorage.setItem("ui_bad", b.v);
      b = null;
    }
    if (b) localStorage.setItem("ui_booting", b.v);
  } catch (e) { b = null; }
  window.UI_VER = b ? b.v : window.UI_BUNDLED || "";
  window.UI_FROM = b ? "下载" : "内置";
  window.uiBootOk = function () { try { localStorage.removeItem("ui_booting"); } catch (e) { /* 没有存储就算了 */ } };
  if (b) {                                           // 样式在 <head> 里就换掉，正文画出来时已经是新样式
    var st = document.createElement("style");
    st.textContent = b.css;
    document.head.appendChild(st);
    var old = document.getElementById("css0");
    if (old) old.disabled = true;
  }
  document.addEventListener("DOMContentLoaded", function () {
    var s = document.createElement("script");
    if (b) {
      [].slice.call(document.body.childNodes).forEach(function (n) { if (n.nodeName !== "SCRIPT") document.body.removeChild(n); });
      document.body.insertAdjacentHTML("afterbegin", b.body);
      s.textContent = b.js + "\n//# sourceURL=ui-" + b.v + ".js";
    } else {
      s.src = "app.js";
    }
    document.body.appendChild(s);
  });
})();
