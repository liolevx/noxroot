import type { NoxrootConfig } from "../config/schema.js";

export interface AutonomyCapability {
  required: number;
  effective: number;
  authorized: boolean;
  reason: string;
}

export interface EffectiveAutonomy {
  read: AutonomyCapability;
  guided: AutonomyCapability;
  worker: AutonomyCapability;
  reviewer: AutonomyCapability;
  merge: AutonomyCapability;
  delivery: AutonomyCapability;
}

function capability(
  required: number,
  effective: number,
  label: string,
  disabled = false,
): AutonomyCapability {
  const authorized = !disabled && effective >= required;
  return {
    required,
    effective,
    authorized,
    reason: disabled
      ? `${label} is disabled in the MVP regardless of configured level.`
      : authorized
        ? `${label} is authorized at level ${effective} (minimum ${required}).`
        : `${label} requires level ${required}; effective level is ${effective}.`,
  };
}

export function effectiveAutonomy(config: NoxrootConfig | undefined): EffectiveAutonomy {
  const implementation = Math.min(3, config?.autonomy.implementation ?? 1);
  const review = Math.min(3, config?.autonomy.review ?? 0);
  return {
    read: capability(0, Math.min(3, config?.autonomy.default ?? 0), "Read-only planning"),
    guided: capability(1, implementation, "Guided task recording"),
    worker: capability(2, implementation, "Command-adapter worker execution"),
    reviewer: capability(3, review, "Independent reviewer and repair execution"),
    merge: capability(4, Math.min(3, config?.autonomy.merge ?? 0), "Merge", true),
    delivery: capability(5, Math.min(3, config?.autonomy.delivery ?? 0), "Delivery", true),
  };
}
