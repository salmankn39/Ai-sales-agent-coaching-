"use client";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * THE MODAL BACKDROP, ALWAYS OVER THE WHOLE SCREEN.
 *
 * `position: fixed` is relative to the viewport only while no ancestor forms a
 * containing block, and in this app almost every ancestor does:
 *
 *  - `.card` and `.glass` animate in with `animation: appUp ... both`. A filled
 *    transform animation leaves the computed transform at the identity MATRIX, not
 *    `none`, and any value other than `none` is enough. Measured in Chromium: a fixed
 *    child of an animated card reports the card's box, 720x160, where the same child
 *    of a plain card reports the viewport, 800x600.
 *  - `.card:hover` adds a real translate on desktop. The backdrop is a descendant of
 *    the card, so hovering the backdrop hovers the card, and a CSS-only fix to the
 *    animation would still snap the modal back into the card the moment the mouse
 *    moved over it.
 *  - `.pop-card` and `.veil` themselves use `backdrop-filter`, which is why a Pick
 *    opened inside a modal was clipped back in August (see _pick.tsx).
 *
 * A modal rendered inline was therefore pinned to its card's box and painted under the
 * cards below it (the owner, 2026-08-21, on the Playbooks Edit button: "it hides behind
 * some shit"). Portalling to <body> puts the backdrop outside every card, so no
 * caller has to know what it happens to be nested inside.
 */
export default function Veil({ onClose, style, children }: {
  onClose?: () => void;
  style?: CSSProperties;
  children: ReactNode;
}) {
  // Portals need a DOM node, which does not exist during the server render.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready || typeof document === "undefined") return null;

  return createPortal(
    <div className="veil" style={style} onClick={onClose}>{children}</div>,
    document.body,
  );
}
