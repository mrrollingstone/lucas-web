import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MemberReviewClient } from "./MemberReviewClient";

/**
 * /members/review
 *
 * HelloHosty member route. Checks for a valid HH session cookie or JWT.
 * - If valid: renders the funnel with free first review + 30% off subsequent
 * - If not logged in: redirects to HH login with returnTo
 *
 * The HH session cookie is expected to be `hh_session` containing a JWT.
 * In production, verify against HelloHosty's JWT secret or call the HH
 * auth API to validate.
 */

const HH_LOGIN_URL = "https://www.hellohosty.com/login";
const HH_SESSION_COOKIE = "hh_session";
const HH_JWT_SECRET = process.env.HH_JWT_SECRET; // For local JWT verify

interface HHSessionPayload {
  sub: string;       // user ID
  email: string;
  name: string;
  plan?: string;     // "free_trial" | "starter" | "pro"
  iat: number;
  exp: number;
}

async function validateSession(): Promise<HHSessionPayload | null> {
  const cookieStore = cookies();
  const sessionCookie = cookieStore.get(HH_SESSION_COOKIE);

  if (!sessionCookie?.value) return null;

  try {
    // Decode the JWT payload (middle segment)
    // In production, use jose or jsonwebtoken to VERIFY the signature
    // against HH_JWT_SECRET. For now we decode + check expiry.
    const parts = sessionCookie.value.split(".");
    if (parts.length !== 3) return null;

    const payload: HHSessionPayload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf-8"),
    );

    // Check expiry
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;

    // TODO: When HH_JWT_SECRET is available, verify signature:
    // import { jwtVerify } from 'jose';
    // const { payload } = await jwtVerify(sessionCookie.value, secret);

    return payload;
  } catch {
    return null;
  }
}

export default async function MembersReviewPage() {
  const session = await validateSession();

  if (!session) {
    // Not logged in — redirect to HH login with return URL
    const returnTo = encodeURIComponent("/members/review");
    redirect(`${HH_LOGIN_URL}?returnTo=${returnTo}`);
  }

  // Valid member — render the member funnel
  return (
    <MemberReviewClient
      memberEmail={session.email}
      memberName={session.name}
      memberId={session.sub}
      memberPlan={session.plan}
    />
  );
}
