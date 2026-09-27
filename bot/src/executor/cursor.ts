/**
 * A visible agent cursor for the agent's Chrome pages, injected with `bsk evaluate` after every navigation.
 *
 * bsk (extension 0.3.1) clicks through CDP `Input.dispatchMouseEvent`: a `mouseMoved` to the element's point,
 * then `mousePressed`/`mouseReleased`. Those arrive in the page as trusted mousemove/pointerdown/click events,
 * so the overlay just follows them. `fill` focuses the field and uses `Input.insertText` (no mouse events),
 * so the overlay also glides to the centre of whatever receives focus (focusin).
 *
 * Rules the script keeps: installs once per document (a window flag), draws in a closed shadow root on
 * <html> with pointer-events none and the maximum z-index, never changes page text, never uses innerHTML
 * (pages with Trusted Types stay happy) and only uses CSSOM and Web Animations (pages with strict CSP too).
 */

export const CURSOR_FLAG = "__otsAgentCursor";
export const CURSOR_Z = 2147483647;

export interface CursorOptions {
  /** Glide time in ms. */
  glideMs?: number;
}

/** Apple-style arrow: black fill, white outline, soft drop shadow. 24 px box, tip at (3, 2). */
const ARROW_PATH = "M3 2 L3 19.5 L7.6 15.4 L10.6 22.2 L13.6 20.9 L10.7 14.2 L16.8 14.2 Z";

/** The overlay script as a single JS expression for `bsk evaluate`. Returns "installed" or "present". */
export function cursorScript(o: CursorOptions = {}): string {
  const glide = Math.max(0, Math.min(2_000, Math.round(o.glideMs ?? 250)));
  // Everything the page could see is created with DOM APIs; values are constants, no page data is read into markup.
  return `(() => {
  const w = window, d = document;
  if (w[${JSON.stringify(CURSOR_FLAG)}]) return "present";
  w[${JSON.stringify(CURSOR_FLAG)}] = true;
  const host = d.createElement("ots-agent-cursor");
  host.setAttribute("aria-hidden", "true");
  const hs = host.style;
  hs.position = "fixed"; hs.left = "0"; hs.top = "0"; hs.width = "0"; hs.height = "0";
  hs.pointerEvents = "none"; hs.zIndex = "${CURSOR_Z}"; hs.contain = "layout style";
  const root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
  const NS = "http://www.w3.org/2000/svg";
  const arrow = d.createElementNS(NS, "svg");
  arrow.setAttribute("width", "24"); arrow.setAttribute("height", "24"); arrow.setAttribute("viewBox", "0 0 24 24");
  const as = arrow.style;
  as.position = "fixed"; as.left = "0"; as.top = "0"; as.pointerEvents = "none"; as.opacity = "0";
  as.filter = "drop-shadow(0 1px 1.5px rgba(0,0,0,.35)) drop-shadow(0 3px 6px rgba(0,0,0,.18))";
  as.transition = "transform ${glide}ms cubic-bezier(.22,.8,.26,1), opacity 180ms ease";
  as.willChange = "transform";
  const path = d.createElementNS(NS, "path");
  path.setAttribute("d", ${JSON.stringify(ARROW_PATH)});
  path.setAttribute("fill", "#111"); path.setAttribute("stroke", "#fff");
  path.setAttribute("stroke-width", "1.6"); path.setAttribute("stroke-linejoin", "round");
  arrow.appendChild(path);
  root.appendChild(arrow);
  (d.documentElement || d.body).appendChild(host);
  let x = -1, y = -1;
  const moveTo = (nx, ny) => {
    if (!(nx > 0 && ny > 0 && nx <= w.innerWidth && ny <= w.innerHeight)) return false;
    x = nx; y = ny;
    as.transform = "translate(" + (nx - 3) + "px," + (ny - 2) + "px)";
    as.opacity = "1";
    return true;
  };
  const ripple = () => {
    if (x < 0) return;
    const r = d.createElementNS(NS, "svg");
    r.setAttribute("width", "44"); r.setAttribute("height", "44"); r.setAttribute("viewBox", "0 0 44 44");
    const c = d.createElementNS(NS, "circle");
    c.setAttribute("cx", "22"); c.setAttribute("cy", "22"); c.setAttribute("r", "20");
    c.setAttribute("fill", "rgba(0,113,227,.18)"); c.setAttribute("stroke", "rgba(0,113,227,.55)"); c.setAttribute("stroke-width", "1.5");
    r.appendChild(c);
    const rs = r.style;
    rs.position = "fixed"; rs.left = (x - 22) + "px"; rs.top = (y - 22) + "px"; rs.pointerEvents = "none";
    root.insertBefore(r, arrow);
    const done = () => r.remove();
    if (r.animate) {
      const a = r.animate([{ transform: "scale(.3)", opacity: 1 }, { transform: "scale(1.15)", opacity: 0 }], { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" });
      a.onfinish = done;
    } else setTimeout(done, 520);
  };
  const centre = (el) => {
    if (!el || !el.getBoundingClientRect) return;
    const b = el.getBoundingClientRect();
    if (b.width || b.height) moveTo(b.left + b.width / 2, b.top + b.height / 2);
  };
  const opts = { capture: true, passive: true };
  w.addEventListener("mousemove", (e) => moveTo(e.clientX, e.clientY), opts);
  w.addEventListener("pointerdown", (e) => { if (!moveTo(e.clientX, e.clientY)) centre(e.target); ripple(); }, opts);
  w.addEventListener("click", (e) => { if (!moveTo(e.clientX, e.clientY)) centre(e.target); }, opts);
  w.addEventListener("focusin", (e) => centre(e.target), opts);
  return "installed";
})()`;
}
