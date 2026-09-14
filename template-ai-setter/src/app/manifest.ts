import type { MetadataRoute } from "next";

// A real web-app manifest with scope "/" - without it, iOS treats navigation
// from the home-screen app to HQ pages (/pipeline etc.) as leaving the app and
// opens them in a Safari sheet. With the scope declared, the whole site stays
// inside the standalone shell.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Student OS",
    short_name: "Student OS",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#050505",
    theme_color: "#050505",
    icons: [{ src: "/apple-icon.png", sizes: "360x360", type: "image/png" }],
  };
}
