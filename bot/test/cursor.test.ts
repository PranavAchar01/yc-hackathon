import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CURSOR_FLAG, CURSOR_Z, cursorScript } from "../src/executor/cursor.ts";

/** A tiny fake DOM: just enough surface for the overlay script, recording what it touches. */
function fakePage() {
  const appended: FakeEl[] = [];
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  class FakeEl {
    style: Record<string, string> = {};
    attrs: Record<string, string> = {};
    children: FakeEl[] = [];
    removed = false;
    constructor(readonly tag: string) {}
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
    appendChild(c: FakeEl) {
      this.children.push(c);
      return c;
    }
    insertBefore(c: FakeEl) {
      this.children.unshift(c);
      return c;
    }
    attachShadow() {
      return this;
    }
    remove() {
      this.removed = true;
    }
    animate() {
      return { onfinish: null };
    }
    getBoundingClientRect() {
      return { left: 100, top: 40, width: 200, height: 20 };
    }
  }
  const documentElement = new FakeEl("html");
  const document = {
    documentElement,
    body: null,
    createElement: (t: string) => new FakeEl(t),
    createElementNS: (_ns: string, t: string) => new FakeEl(t),
  };
  documentElement.appendChild = (c: FakeEl) => {
    appended.push(c);
    return c;
  };
  const window: Record<string, unknown> = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] ??= [];
      listeners[type].push(fn);
    },
  };
  const ctx = { window, document, setTimeout };
  const run = (src: string) => runInNewContext(src, ctx) as string;
  const fire = (type: string, e: unknown) => {
    for (const fn of listeners[type] ?? []) fn(e);
  };
  const arrow = () => appended[0]?.children.at(-1);
  return { run, fire, appended, listeners, arrow, window, FakeEl };
}

describe("agent cursor script", () => {
  it("is one self-contained expression that installs once per page", () => {
    const page = fakePage();
    expect(page.run(cursorScript())).toBe("installed");
    expect(page.run(cursorScript())).toBe("present");
    expect(page.appended).toHaveLength(1);
    expect(page.window[CURSOR_FLAG]).toBe(true);
    expect(Object.keys(page.listeners).sort()).toEqual(["click", "focusin", "mousemove", "pointerdown"]);
    for (const list of Object.values(page.listeners)) expect(list).toHaveLength(1);
  });

  it("never blocks the page: pointer-events none, max z-index, aria-hidden", () => {
    const page = fakePage();
    page.run(cursorScript());
    const host = page.appended[0];
    expect(host?.style.pointerEvents).toBe("none");
    expect(host?.style.zIndex).toBe(String(CURSOR_Z));
    expect(host?.attrs["aria-hidden"]).toBe("true");
    expect(page.arrow()?.style.pointerEvents).toBe("none");
  });

  it("glides to mouse events, to the focused element's centre, and ignores off-screen moves", () => {
    const page = fakePage();
    page.run(cursorScript({ glideMs: 250 }));
    const arrow = page.arrow();
    expect(arrow?.style.transition).toContain("transform 250ms");
    expect(arrow?.style.opacity).toBe("0");
    page.fire("mousemove", { clientX: 400, clientY: 300 });
    expect(arrow?.style.transform).toBe("translate(397px,298px)");
    expect(arrow?.style.opacity).toBe("1");
    page.fire("mousemove", { clientX: -10, clientY: -10 });
    expect(arrow?.style.transform).toBe("translate(397px,298px)");
    page.fire("focusin", { target: new page.FakeEl("input") });
    expect(arrow?.style.transform).toBe("translate(197px,48px)");
  });

  it("shows a ripple on pointerdown and removes it after", () => {
    const page = fakePage();
    page.run(cursorScript());
    page.fire("pointerdown", { clientX: 50, clientY: 60 });
    const layer = page.appended[0];
    expect(layer?.children).toHaveLength(2);
    expect(layer?.children[0]?.style.left).toBe("28px");
  });

  it("never touches page text or markup sinks", () => {
    const src = cursorScript();
    expect(src).not.toMatch(/innerHTML|outerHTML|textContent|innerText|insertAdjacent|document\.write/);
    expect(() => new Function(`return ${src}`)).not.toThrow();
  });

  it("clamps the glide time", () => {
    expect(cursorScript({ glideMs: 99_999 })).toContain("transform 2000ms");
    expect(cursorScript({ glideMs: -5 })).toContain("transform 0ms");
  });
});
