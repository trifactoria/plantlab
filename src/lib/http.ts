import { NextResponse } from "next/server";
import { CameraBusyError } from "./cameraLock";

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Maps a caught camera/v4l2 error to an { message, status } pair for JSON responses. */
export function cameraErrorInfo(error: unknown, fallbackMessage: string) {
  if (error instanceof CameraBusyError) {
    return { message: error.message, status: 409 as const };
  }

  const message = error instanceof Error ? error.message : fallbackMessage;
  return { message, status: 400 as const };
}

export function notFound(message = "Not found") {
  return NextResponse.json({ error: message }, { status: 404 });
}

export function serverError(error: unknown) {
  console.error(error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

export async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }

  return value.trim();
}

export function optionalString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function requiredPositiveInt(value: unknown, field: string) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }

  return parsed;
}

export function requiredGridIndex(value: unknown, field: string) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be zero or greater`);
  }

  return parsed;
}

export function optionalDate(value: unknown, fallback = new Date()) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("timestamp must be a valid date");
  }

  return parsed;
}

export function nullableDate(value: unknown, field = "timestamp") {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a valid date or null`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be a valid date`);
  }

  return parsed;
}
