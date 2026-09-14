import { NextRequest, NextResponse } from "next/server";

// The "Open in Safari" rescue. Telegram's in-app browser signs a student in,
// but its cookies don't follow them to Safari - so reopening the same URL there
// used to dead-end on "Link expired". The login route now KEEPS ?t= in the
// address bar after sign-in; when that URL lands in a browser with no session
// cookie, this middleware routes it back through /app/login so the token mints
// a fresh session wherever the link is opened.
// (Cookie presence only - signature verification stays in the pages/API, which
// have Node crypto. A forged cookie just falls through to their checks.)
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/app/login") || pathname.startsWith("/app/denied")) {
    return NextResponse.next();
  }
  const t = req.nextUrl.searchParams.get("t");
  if (t && !req.cookies.get("student_session")?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/app/login";
    url.search = "";
    url.searchParams.set("t", t);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ["/app/:path*"] };
