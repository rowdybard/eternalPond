export type PublicSoulStatus = "alive" | "resting" | "remembered";

export interface PublicSoulView {
  slug: string;
  name: string;
  tint: number;
  status: PublicSoulStatus;
  completedLives: number;
  dedication?: string;
  currentLife?: {
    kind: "mortal" | "eternal";
    ageText: string;
    remainingPassageText?: string;
    presentation: {
      x: number;
      z: number;
      depth: number;
      heading: number;
      size: number;
      ageRatio: number;
    };
  };
  latestMemorial?: {
    completedAt: number;
    ageText: string;
    rippleAnchor: { x: number; z: number };
  };
}

export interface RetentionCohort {
  day: string;
  newCredentials: number;
  firstBirths: number;
  birthCompletions24h: number;
  birthCompletionRate: number | null;
  eligibleSouls: number;
  returnedSouls: number;
  returnRate: number | null;
  secondVisitSouls: number;
  secondVisitRate: number | null;
  deliveredLetters: number;
  returnedAfterLetter: number;
  letterReturnRate: number | null;
}

export interface RetentionReport {
  generatedAt: number;
  timezone: "UTC";
  cohortAnchor: "first_birth";
  returnWindow: { fromDay: 1; throughDay: 8 };
  from: string;
  to: string;
  totals: {
    eligibleSouls: number;
    returnedSouls: number;
    returnRate: number | null;
    deliveredLetters: number;
    returnedAfterLetter: number;
    letterReturnRate: number | null;
  };
  cohorts: RetentionCohort[];
}

export interface LetterPreferenceSummary {
  available: boolean;
  status: "none" | "pending" | "confirmed" | "unsubscribed" | "suppressed";
  maskedEmail?: string;
  mortalLetters: boolean;
  keeperLetters: boolean;
}

export interface SharingSummary {
  enabled: boolean;
  slug?: string;
  url?: string;
}

export type KeeperPresentationState = "none" | "eligible" | "pending" | "active" | "canceling" | "past_due" | "resting";

export interface KeeperSummary {
  configured: boolean;
  eligible: boolean;
  requiresConfirmedEmail: boolean;
  state: KeeperPresentationState;
  interval?: "month" | "year";
  paidThroughAt?: number;
  fishPhase?: "water" | "dome";
  dedication?: string;
  weeklyLetters: boolean;
}

export interface LinkInspection {
  valid: boolean;
  purpose?: "confirm_email" | "return_soul" | "unsubscribe";
  name?: string;
  slug?: string;
  expiresAt?: number;
}

export interface LinkRedemption {
  ok: boolean;
  purpose?: "confirm_email" | "return_soul" | "unsubscribe";
  name?: string;
  slug?: string;
  token?: string;
  message?: string;
}

export interface KeeperCheckoutPreparation {
  ok: boolean;
  reason?: "unauthorized" | "not_eligible" | "email_required" | "already_active" | "invalid_interval" | "checkout_in_progress";
  attemptId?: string;
  membershipRef?: string;
  customerId?: string;
  idempotencyKey?: string;
  existingSessionId?: string;
  inProgress?: boolean;
}

export interface KeeperPortalPreparation {
  ok: boolean;
  reason?: "unauthorized" | "not_configured";
  customerId?: string;
}

export interface NormalizedStripeSubscription {
  subscriptionId: string;
  membershipRef: string;
  customerId: string;
  status: string;
  priceId: string | null;
  interval: "month" | "year" | null;
  quantity: number;
  cancelAtPeriodEnd: boolean;
  paidThroughAt: number | null;
}

export interface NormalizedStripeEvent {
  eventId: string;
  type: string;
  objectId: string | null;
  createdAt: number;
  checkout?: {
    membershipRef: string;
    customerId: string | null;
    subscriptionId: string | null;
  };
  subscription?: NormalizedStripeSubscription;
  invoicePaid?: boolean;
  invoiceFailed?: boolean;
}
