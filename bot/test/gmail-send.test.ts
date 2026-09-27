import { describe, expect, it } from "vitest";
import { composeUrl, findSendRef, isTestAddress, parseTestInbox, testAddressFor } from "../src/gmail-send.ts";

const inbox = parseTestInbox("someone.test@gmail.com");

describe("real sends only reach test plus-addresses", () => {
  it("rewrites a draft recipient to a plus-address of the test inbox", () => {
    expect(testAddressFor("dana@example.com", inbox)).toBe("someone.test+dana@gmail.com");
    expect(testAddressFor("Weird.Name!!@example.com", inbox)).toBe("someone.test+weird-name@gmail.com");
  });

  it("refuses anything that is not a plus-address of that inbox", () => {
    expect(isTestAddress("someone.test+dana@gmail.com", inbox)).toBe(true);
    expect(isTestAddress("someone.test@gmail.com", inbox)).toBe(false);
    expect(isTestAddress("dana@example.com", inbox)).toBe(false);
    expect(isTestAddress("someone.test+dana@gmail.com.evil.io", inbox)).toBe(false);
    expect(isTestAddress("xsomeone.test+dana@gmail.com", inbox)).toBe(false);
  });

  it("rejects a malformed test inbox", () => {
    expect(() => parseTestInbox("not an email")).toThrow();
  });

  it("builds a prefilled Gmail compose URL", () => {
    const u = new URL(composeUrl("someone.test+dana@gmail.com", "Hi & welcome", "Line 1\nLine 2"));
    expect(u.host).toBe("mail.google.com");
    expect(u.searchParams.get("view")).toBe("cm");
    expect(u.searchParams.get("to")).toBe("someone.test+dana@gmail.com");
    expect(u.searchParams.get("su")).toBe("Hi & welcome");
    expect(u.searchParams.get("body")).toBe("Line 1\nLine 2");
  });

  it("finds Gmail's Send button in an observe dump", () => {
    const dump = '  @e12 button "Send ‪(⌘Enter)‬"\n  @e13 button "More send options [has-submenu]"';
    expect(findSendRef(dump)).toBe("@e12");
    expect(findSendRef('  @e3 button "Discard draft"')).toBeNull();
  });
});
