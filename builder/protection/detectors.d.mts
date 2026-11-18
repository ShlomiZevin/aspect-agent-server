/**
 * Types for detectors.mjs (task #986) — the client imports the module
 * through the `@protection` alias. Keep in step with detectors.mjs.
 * The settings shapes themselves live in builder/types/index.ts.
 */

export type DetectorId =
  | 'il_id' | 'credit_card' | 'iban' | 'bank_account' | 'passport' | 'phone' | 'email';

export interface Localized { he: string; en: string }

export interface DetectorDef {
  id: DetectorId;
  name: Localized;
  matches: Localized;
  defaultOn: boolean;
  check: (text: string, runs: unknown[]) => number;
}

export interface DetectorHit { id: DetectorId; count: number }

export interface ResolvedProtection {
  enabled: boolean;
  detectorIds: DetectorId[];
  blockedMessage: Localized;
  /** Detectors whose switch the crew changed from the agent's. */
  crewOverrides: DetectorId[];
}

interface AgentDpLike { enabled?: boolean; detectors?: Partial<Record<DetectorId, boolean>>; blockedMessage?: Partial<Localized> }
interface CrewDpLike { detectors?: Partial<Record<DetectorId, boolean>> }

export const DETECTORS: DetectorDef[];
export const DETECTOR_IDS: DetectorId[];
export const DEFAULT_BLOCKED_MESSAGE: Localized;
export const MAX_MESSAGE_LENGTH: number;

export function normalize(text: string): string;
export function detect(text: string, detectorIds: readonly string[]): DetectorHit[];
export function resolveSettings(agentDp?: AgentDpLike | null, crewDp?: CrewDpLike | null): ResolvedProtection;
export function messageFor(settings: ResolvedProtection, lang: string): string;
export function checkMessage(
  text: string,
  agentBody: { dataProtection?: AgentDpLike } | null | undefined,
  crewBody: { dataProtection?: CrewDpLike } | null | undefined,
  lang: string,
): null | { detectors: DetectorId[]; message: string };
export function agentSettingsProblems(dp: unknown): string[];
export function crewSettingsProblems(dp: unknown): string[];
