import { handleApiRequest } from "../../../lib/api-core.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request) {
  return handleApiRequest(request);
}

export async function POST(request) {
  return handleApiRequest(request);
}
