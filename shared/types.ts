export type Carrier = "usps" | "ups" | "fedex" | "ontrac" | "dhl" | "other";
export type PackageDirection = "inbound" | "outbound";
export type NotificationMode = "milestones" | "detailed" | "muted";
export type TrackingStatus =
  | "unknown"
  | "pre_transit"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "available_for_pickup"
  | "return_to_sender"
  | "failure"
  | "cancelled"
  | "error";
export interface TrackingEvent {
  id: string;
  occurredAt: string;
  /** Offset-bearing carrier scan time, when supplied by EasyPost. */
  occurredAtLocal?: string | null;
  status: string;
  statusDetail: string;
  description: string;
  location: string;
}
export interface Package {
  id: string;
  trackingNumber: string;
  carrier: Carrier;
  name: string;
  direction: PackageDirection;
  status: TrackingStatus;
  statusDetail: string;
  /** Carrier's estimated delivery calendar date (YYYY-MM-DD). */
  eta: string | null;
  trackerId: string | null;
  carrierTrackingUrl?: string | null;
  notificationMode: NotificationMode;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastEventAt: string | null;
  nextCheckAt: string | null;
  error: string | null;
  events: TrackingEvent[];
}
export interface AddPackageInput {
  trackingNumber: string;
  carrier?: Carrier;
  name?: string;
  direction?: PackageDirection;
}
export interface AddPackageResult {
  trackingNumber: string;
  package?: Package;
  error?: string;
}
export interface PackagePatch {
  name?: string;
  notificationMode?: NotificationMode;
  archived?: boolean;
  direction?: PackageDirection;
}
export interface IntegrationHealth {
  configured: boolean;
  status: "ok" | "disabled" | "error" | "connecting";
  message: string;
}
export interface Health {
  status: "ok" | "degraded";
  version: string;
  easypost: IntegrationHealth;
  photon: IntegrationHealth;
  assistant: IntegrationHealth;
  pendingNotifications: number;
  failedNotifications: number;
}
export interface OutboxMessage {
  id: string;
  recipient: string;
  body: string;
  state: "pending" | "sent" | "failed";
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  error: string | null;
  providerId: string | null;
}

export interface TrackingSpend {
  totalMicrousd: number;
  trackers: number;
}
