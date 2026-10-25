// ===== src/errors.jsx =====
// Browser errors reach the platform's error list (docs/06 S6; API
// POST /api/client-errors, page A08): uncaught errors and promise
// rejections (window), and render errors of a page (ErrorBoundary). The
// server scrubs and groups them; here each distinct error is sent at most
// once a minute and 20 times a page load. Never in demo mode (?demo=1
// sends nothing to /api).
//
//   reportClientError(err, { kind, componentStack, route })
//   <ErrorBoundary resetKey={route} route="#/page">{page}</ErrorBoundary>
//     route: the page being shown (the URL hash follows it only after the render)
//     a page that throws shows «حدث خطأ في هذه الصفحة» with «إعادة المحاولة»
//     instead of a blank app; a new resetKey (another page) clears it.

(function () {
  "use strict";
  var sentAt = {};
  var sent = 0;
  function isDemo() {
    try { return new URLSearchParams(window.location.search).get("demo") === "1"; } catch (_) { return false; }
  }
  function reportClientError(err, info) {
    try {
      if (isDemo() || sent >= 20 || !window.ClinicApi) return;
      var message = String((err && (err.message || err.reason)) || err || "Error").slice(0, 500);
      var route = String((info && info.route) || window.location.hash || "#/").split("?")[0];
      var key = message + "|" + route;
      var now = Date.now();
      if (sentAt[key] && now - sentAt[key] < 60000) return;
      sentAt[key] = now;
      sent += 1;
      var body = {
        message: message,
        stack: String((err && err.stack) || "").slice(0, 3500),
        route: route,
        kind: (info && info.kind) || "window",
      };
      if (info && info.componentStack) body.component = String(info.componentStack).trim().split("\n")[0].slice(0, 200);
      window.ClinicApi.request("POST", "/client-errors", body);
    } catch (_) { /* reporting must never fail the page */ }
  }
  window.reportClientError = reportClientError;
  window.addEventListener("error", function (e) { reportClientError(e.error || e.message, { kind: "window" }); });
  window.addEventListener("unhandledrejection", function (e) { reportClientError(e.reason, { kind: "promise" }); });
})();

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.retry = () => this.setState({ error: null });
  }
  static getDerivedStateFromError(error) { return { error: error }; }
  componentDidCatch(error, info) {
    window.reportClientError(error, { kind: "react", componentStack: info && info.componentStack, route: this.props.route });
  }
  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" role="alert" data-error-boundary="" style={{ maxWidth: 520, margin: "48px auto", padding: "28px 24px", textAlign: "center" }}>
        <div className="h3" style={{ marginBottom: 8 }}>{tt("حدث خطأ في هذه الصفحة")}</div>
        <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.7, marginBottom: 18 }}>
          {tt("وصل الخطأ إلى فريق المنصة. أعد المحاولة، أو انتقل إلى صفحة أخرى من القائمة.")}
        </div>
        <button type="button" className="btn btn-blue" onClick={this.retry}>{tt("إعادة المحاولة")}</button>
      </div>
    );
  }
}
window.ErrorBoundary = ErrorBoundary;
