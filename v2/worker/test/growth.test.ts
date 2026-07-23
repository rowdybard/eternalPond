import { describe, expect, it } from "vitest";
import {
  addUtcDays,
  deterministicMemorialPoint,
  isPublicSlug,
  normalizeDedication,
  publicSlugBase,
  remainingPassage,
  utcDay,
  validatedDateRange,
} from "../src/growth-utils";
import { decryptText, encryptText, keyedEmailHash, maskEmail, normalizeEmail, randomToken } from "../src/crypto";

describe("growth helpers", () => {
  it("normalizes stable public slugs and validates route input", () => {
    expect(publicSlugBase("Quiet Thistle under Glass")).toBe("quiet-thistle-under-glass");
    expect(publicSlugBase("  Still—Rain  ")).toBe("still-rain");
    expect(isPublicSlug("quiet-thistle-under-glass")).toBe(true);
    expect(isPublicSlug("../private")).toBe(false);
    expect(deterministicMemorialPoint("quiet-thistle")).toEqual(deterministicMemorialPoint("quiet-thistle"));
  });

  it("uses exact UTC-day arithmetic for retention windows", () => {
    const born = Date.parse("2026-07-01T23:59:59.000Z");
    expect(utcDay(born)).toBe("2026-07-01");
    expect(addUtcDays("2026-07-01", 8)).toBe("2026-07-09");
    expect(validatedDateRange("2026-07-01", "2026-07-09", born)).toEqual({ from: "2026-07-01", to: "2026-07-09" });
    expect(validatedDateRange("2026-07-09", "2026-07-01", born)).toBeNull();
  });

  it("keeps life copy approximate and dedication plain", () => {
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    expect(remainingPassage(now + 25 * 60 * 60 * 1000, now)).toBe("within a turning day");
    expect(normalizeDedication("  for   everyone by the water  ")).toBe("for everyone by the water");
    expect(normalizeDedication("bad\u0000note")).toBeNull();
    expect(normalizeDedication("x".repeat(161))).toBeNull();
  });

  it("validates, masks, hashes, and encrypts email without plaintext storage", async () => {
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    const key = btoa(String.fromCharCode(...keyBytes));
    const email = normalizeEmail(" Quiet.Thistle@Example.COM ");
    expect(email).toBe("quiet.thistle@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(maskEmail(email ?? "")).toBe("qu…@example.com");
    const encrypted = await encryptText(email ?? "", key);
    expect(encrypted.ciphertext).not.toContain("quiet.thistle");
    expect(await decryptText(encrypted, key)).toBe(email);
    expect(await keyedEmailHash(email ?? "", key)).toBe(await keyedEmailHash(email ?? "", key));
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
  });
});
