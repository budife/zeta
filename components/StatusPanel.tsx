"use client";

import type { AppStatus } from "@/lib/types";
import type { RegionKind } from "@/lib/regions";

export type StatusPanelProps = {
  status: AppStatus;
};

const CAMERA_TEXT: Record<AppStatus["camera"], string> = {
  off: "Off",
  starting: "Starting…",
  ready: "Ready",
  error: "Error",
};

function handText(count: number): string {
  if (count === 0) return "Not Detected";
  return `${count} detected`;
}

function faceText(face: AppStatus["face"]): string {
  switch (face) {
    case "none":
      return "Not Detected";
    case "outside":
      return "Outside Frame";
    case "in-frame":
      return "Detected";
  }
}

const REGION_LABELS: Partial<Record<RegionKind, string>> = {
  "left-eye": "Left Eye",
  "right-eye": "Right Eye",
  eyes: "Eyes",
  face: "Face",
  head: "Head",
  neck: "Neck",
  torso: "Torso",
  "left-arm": "Left Arm",
  "right-arm": "Right Arm",
  "left-hand": "Left Hand",
  "right-hand": "Right Hand",
  "left-leg": "Left Leg",
  "right-leg": "Right Leg",
};

/**
 * The small live status line under the stage, exactly as specified:
 * Camera / Hands / Frame / Face / Vector.
 */
export function StatusPanel({ status }: StatusPanelProps) {
  const rows: Array<{ label: string; value: string; tone?: "ok" | "warn" }> = [
    { label: "Camera", value: CAMERA_TEXT[status.camera], tone: status.camera === "ready" ? "ok" : undefined },
    { label: "Hands", value: handText(status.hands), tone: status.hands === 2 ? "ok" : undefined },
    { label: "Frame", value: status.frame === "active" ? "Active" : "Not Active", tone: status.frame === "active" ? "ok" : undefined },
    { label: "Face", value: faceText(status.face), tone: status.face === "in-frame" ? "ok" : undefined },
    {
      label: "Region",
      value: status.region === null ? "Clipping" : (REGION_LABELS[status.region] ?? "Clipping"),
      tone: status.region === null ? undefined : "ok",
    },
    {
      label: "Confidence",
      value: status.region === null ? "—" : status.regionConfidence.toFixed(2),
    },
    {
      label: "Media",
      value: status.frame === "active" ? "Visible" : "Inactive",
      tone: status.frame === "active" ? "ok" : undefined,
    },
  ];

  return (
    <ul className="status-panel">
      {rows.map((row) => (
        <li key={row.label} className={`status-item ${row.tone === "ok" ? "status-item--ok" : ""}`}>
          <span className="status-item__dot" aria-hidden="true" />
          <span className="status-item__label">{row.label}</span>
          <span className="status-item__value">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}
