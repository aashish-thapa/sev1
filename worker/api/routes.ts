import { ProgressSchema } from "../../src/domain/progress.ts";
import { SaveRequestSchema, SignInRequestSchema, SignUpRequestSchema } from "../../src/storage/account-protocol.ts";
import { AccountService, CredentialsSchema, SESSION_SECONDS, type AuthResult } from "./accounts.ts";
import { clearedSessionCookie, failure, isSameOrigin, json, readBody, sessionCookie, sessionTokenOf } from "./http.ts";

/** HTTP for /api: parse, call the account service, shape the response. No rules live here. */
export async function handleApi(request: Request, accounts: AccountService): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;
  if (request.method !== "GET" && !isSameOrigin(request)) return failure("forbidden", "Cross-site requests are not allowed.", 403);
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";

  switch (route) {
    case "POST /api/signup": {
      const body = await readBody(request, SignUpRequestSchema);
      if (!body.ok) return body.response;
      const credentials = CredentialsSchema.safeParse(body.data);
      if (!credentials.success) return failure("invalid", credentials.error.issues[0]?.message ?? "Check your username and password.", 400);
      const anonymous = ProgressSchema.safeParse(body.data.progress);
      const result = await accounts.signUp(credentials.data.username, credentials.data.password, anonymous.success ? anonymous.data : null, address);
      return signedIn(result, 201);
    }
    case "POST /api/login": {
      const body = await readBody(request, SignInRequestSchema);
      if (!body.ok) return body.response;
      const credentials = CredentialsSchema.safeParse(body.data);
      if (!credentials.success) return failure("bad_credentials", "Wrong username or password.", 401);
      return signedIn(await accounts.signIn(credentials.data.username, credentials.data.password, address), 200);
    }
    case "POST /api/logout": {
      const token = sessionTokenOf(request);
      if (token) await accounts.signOut(token);
      return new Response(null, { status: 204, headers: { "set-cookie": clearedSessionCookie() } });
    }
    case "GET /api/me": {
      const user = await accounts.userFor(sessionTokenOf(request));
      return json({ account: user ? { username: user.username } : null });
    }
    case "GET /api/progress": {
      const user = await accounts.userFor(sessionTokenOf(request));
      if (!user) return failure("signed_out", "Sign in to load saved progress.", 401);
      return json({ progress: await accounts.progressOf(user) });
    }
    case "PUT /api/progress": {
      const user = await accounts.userFor(sessionTokenOf(request));
      if (!user) return failure("signed_out", "Sign in to save progress.", 401);
      const body = await readBody(request, SaveRequestSchema);
      if (!body.ok) return body.response;
      const progress = ProgressSchema.safeParse(body.data.progress);
      if (!progress.success) return failure("invalid", "That isn't saved progress.", 400);
      const saved = await accounts.saveProgress(user, progress.data);
      return saved.ok ? json({ updatedAt: saved.updatedAt }) : json({ error: "rejected", current: saved.current }, 409);
    }
    default:
      return failure("not_found", `No route for ${route}.`, 404);
  }
}

const FAILURE_STATUS = { username_taken: 409, bad_credentials: 401, rate_limited: 429 } as const;
const FAILURE_MESSAGE = {
  username_taken: "That username is taken.",
  bad_credentials: "Wrong username or password.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
} as const;

function signedIn(result: AuthResult, status: number): Response {
  if (!result.ok) return failure(result.failure, FAILURE_MESSAGE[result.failure], FAILURE_STATUS[result.failure]);
  const { account, token, progress } = result.value;
  return json({ account, progress }, status, { "set-cookie": sessionCookie(token, SESSION_SECONDS) });
}
