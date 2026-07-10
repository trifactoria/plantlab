import { NextResponse } from "next/server";

export function productionLocalOnlyResponse() {
  if (process.env.NODE_ENV !== "production") {
    return null;
  }

  return NextResponse.json(
    { error: "Local camera features are unavailable in production." },
    { status: 403 },
  );
}
