import { HQ_THEME_SCRIPT } from "./_hq-theme";
import { SKIN_CSS, SKIN_SCRIPT, DS_CSS } from "./_skin";
import SkinToggle from "./_skin-toggle";

export const metadata = {
  title: "AI Setter",
  description: "AI DM Appointment Setter",
  // "Add to Home Screen" opens like a real app: no Safari chrome, dark status
  // bar, and BLACK launch screens per device - without these iOS flashes its
  // default WHITE backdrop between tap and first paint (the owner's "lightning").
  appleWebApp: {
    capable: true, statusBarStyle: "black-translucent" as const, title: "Student OS",
    startupImage: [
      [430, 932, 3], [393, 852, 3], [390, 844, 3], [428, 926, 3],
      [375, 812, 3], [414, 896, 2], [414, 896, 3], [375, 667, 2], [414, 736, 3],
    ].map(([w, h, r]) => ({
      url: `/splash/launch-${w}x${h}@${r}.png`,
      media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)`,
    })),
  },
};

// viewportFit cover lets env(safe-area-inset-*) work, so the bottom tab bar can
// pad itself above the iPhone home indicator / Safari's floating address bar.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-skin="dark">
      <head>
        {/* Apply saved skin + ?hq preview before first paint (no flash), keep iframes in sync. */}
        <script dangerouslySetInnerHTML={{ __html: SKIN_SCRIPT + HQ_THEME_SCRIPT }} />
        {/* Two-skin design system: color tokens (Dark + Light) + shared Apple components. */}
        <style dangerouslySetInnerHTML={{ __html: SKIN_CSS }} />
        <style dangerouslySetInnerHTML={{ __html: DS_CSS }} />
      </head>
      <body style={{ margin: 0, background: "#0a0a0a" }}>
        {/* iPhone status-bar law, site-wide: content starts below the clock and
            scrolls away UNDER the opaque shield - no page can ever touch the
            system icons. Desktop: env() is 0, nothing changes. */}
        <style dangerouslySetInnerHTML={{ __html: "body{padding:0;padding-top:env(safe-area-inset-top,0px);}" }} />
        <div aria-hidden style={{ position: "fixed", top: 0, left: 0, right: 0, height: "env(safe-area-inset-top, 0px)", background: "var(--bg, #0a0a0a)", zIndex: 190 }} />
        {children}
        <SkinToggle />
      </body>
    </html>
  );
}
