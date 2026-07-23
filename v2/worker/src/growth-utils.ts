import { hashString32, poeticAge } from "@eternal-pond/shared";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function utcDayStart(day: string): number | null {
  if (!ISO_DAY_PATTERN.test(day)) return null;
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && utcDay(timestamp) === day ? timestamp : null;
}

export function addUtcDays(day: string, amount: number): string {
  const start = utcDayStart(day);
  if (start === null) throw new Error("invalid_utc_day");
  return utcDay(start + amount * DAY_MS);
}

export function validatedDateRange(from: string | null, to: string | null, now = Date.now()): { from: string; to: string } | null {
  const defaultTo = utcDay(now);
  const defaultFrom = utcDay(now - 90 * DAY_MS);
  const parsedFrom = utcDayStart(from ?? defaultFrom);
  const parsedTo = utcDayStart(to ?? defaultTo);
  if (parsedFrom === null || parsedTo === null || parsedFrom > parsedTo || parsedTo - parsedFrom > 366 * DAY_MS) return null;
  return { from: utcDay(parsedFrom), to: utcDay(parsedTo) };
}

export function fraction(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
}

export function publicSlugBase(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 58)
    .replace(/-+$/gu, "");
  return base || "quiet-soul";
}

export function isPublicSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value);
}

export function deterministicMemorialPoint(slug: string): { x: number; z: number } {
  const hash = hashString32(slug);
  const angle = (hash / 0xffffffff) * Math.PI * 2;
  const radius = 0.11 + ((hash >>> 8) % 1000) / 1000 * 0.09;
  return { x: 0.5 + Math.cos(angle) * radius, z: 0.5 + Math.sin(angle) * radius };
}

export function approximateLifeAge(bornAt: number, now: number): string {
  if (now - bornAt < 5 * 60 * 1000) return "just born";
  return poeticAge(bornAt, now);
}

export function remainingPassage(endsAt: number | null, now: number): string | undefined {
  if (endsAt === null) return undefined;
  const remaining = endsAt - now;
  if (remaining <= 0) return "entering its final passage";
  if (remaining < 12 * 60 * 60 * 1000) return "its final passage is drawing near";
  if (remaining < 36 * 60 * 60 * 1000) return "within a turning day";
  if (remaining < 4 * DAY_MS) return "a few passages remain";
  return "several passages remain";
}

export function normalizeDedication(value: string): string | null {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  const codePoints = [...normalized];
  if (codePoints.length > 160) return null;
  return normalized;
}

export const GROWTH_DAY_MS = DAY_MS;
