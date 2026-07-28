import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";

export interface AuthResult {
  user: User;
}

export async function requireAuth(): Promise<
  AuthResult | NextResponse
> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json(
      { error: "Unauthorized", code: "NOT_AUTHENTICATED" },
      { status: 401 }
    );
  }

  return { user };
}

export function withAuth(
  handler: (req: Request, auth: AuthResult) => Promise<NextResponse>
) {
  return async (request: Request): Promise<NextResponse> => {
    const authResult = await requireAuth();
    if (authResult instanceof NextResponse) return authResult;
    return handler(request, authResult);
  };
}
