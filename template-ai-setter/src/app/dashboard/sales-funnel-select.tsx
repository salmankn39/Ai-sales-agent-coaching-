"use client";
import Pick from "@/app/_pick";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * The Sales block's funnel selector (All / Outbound / Inbound). Sets the
 * `funnel` URL param while preserving period/source/custom dates — only the
 * Sales numbers change server-side; both funnel blocks always render.
 */
export default function SalesFunnelSelect({ funnel }: { funnel: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function onChange(next: string) {
    const p = new URLSearchParams(params.toString());
    if (next === "all") p.delete("funnel");
    else p.set("funnel", next);
    startTransition(() => router.push(`/dashboard?${p.toString()}`));
  }

  return (
    <Pick value={funnel} title="Which funnel?"
      options={[{ value: "all", label: "All funnels" }, { value: "outbound", label: "Outbound" }, { value: "inbound", label: "Inbound" }]}
      onChange={onChange} style={{ opacity: pending ? 0.55 : 1 }} />
  );
}
