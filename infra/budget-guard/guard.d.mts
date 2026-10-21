import type { RequestListener } from "node:http";

export interface Decision {
  action: "ignore" | "none" | "revoke";
  reason?: string;
  cost?: number;
  budget?: number;
  currency?: string;
  interval?: string;
}
export interface IamBinding { role: string; members?: string[]; condition?: unknown }
export interface IamPolicy { bindings?: IamBinding[]; etag?: string; version?: number }

export function decide(push: unknown, budgetId: string | undefined, now?: number): Decision;
export function withoutPublicAccess(policy: IamPolicy): IamPolicy | null;
export function revokePublicAccess(service: string, fetchImpl?: typeof fetch): Promise<"revoked" | "already-private">;
export function createGuard(options: {
  service: string;
  budgetId: string;
  revoke?: (service: string) => Promise<string>;
  log?: (entry: Record<string, unknown>) => void;
}): RequestListener;
