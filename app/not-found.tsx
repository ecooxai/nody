import Link from "next/link";

import { Panel } from "@/components/ui/panel";

export default function NotFound() {
  return (
    <div className="relative isolate py-8 sm:py-12">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(233,95,56,0.08),transparent_32%),radial-gradient(circle_at_top_right,rgba(18,76,65,0.08),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.92),rgba(245,241,232,0.7))]" />

      <Panel className="mx-auto max-w-2xl rounded-[28px] border-ink/8 bg-white/72 p-8 shadow-none backdrop-blur-sm sm:p-10">
        <div className="text-xs uppercase tracking-[0.24em] text-ink/45">Not found</div>
        <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-5xl">This page does not exist.</h1>
        <p className="mt-4 max-w-xl text-base leading-7 text-ink/68">
          The link may be stale, or the page may have moved. Return to the workspace or the home page to continue.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            className="inline-flex items-center justify-center rounded-full bg-ink px-5 py-3 text-sm font-medium text-white transition hover:bg-ink/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            href="/workspace"
          >
            Open workspace
          </Link>
          <Link
            className="inline-flex items-center justify-center rounded-full border border-ink/12 bg-white px-5 py-3 text-sm font-medium text-ink transition hover:border-ink/20 hover:bg-mist focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            href="/"
          >
            Go home
          </Link>
        </div>
      </Panel>
    </div>
  );
}
