import Link from "next/link";

import { Panel } from "@/components/ui/panel";

export default function HomePage() {
  return (
    <div className="relative isolate py-8 sm:py-12">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(233,95,56,0.08),transparent_32%),radial-gradient(circle_at_top_right,rgba(18,76,65,0.08),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.92),rgba(245,241,232,0.7))]" />

      <div className="grid gap-6 lg:grid-cols-[1.15fr,0.85fr]">
        <Panel className="overflow-hidden rounded-[28px] border-ink/8 bg-white/72 p-8 shadow-none backdrop-blur-sm sm:p-10">
          <div className="max-w-2xl">
            <div className="flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.28em] text-ink/45">
              <span className="rounded-full border border-ink/10 bg-white px-3 py-1">Cloud sync</span>
              <span className="rounded-full border border-ink/10 bg-white px-3 py-1">AI editing</span>
              <span className="rounded-full border border-ink/10 bg-white px-3 py-1">Edge storage</span>
            </div>
            <h1 className="mt-8 max-w-xl text-4xl font-semibold tracking-[-0.04em] text-ink sm:text-6xl">
              A clean workspace for notes, embeds, and AI-assisted edits.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-ink/68">
              Nody keeps the surface simple: a focused editor, synced content across devices, and flexible provider settings when you need them.
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
                href="/sign-up"
              >
                Create account
              </Link>
            </div>
            <div className="mt-10 grid gap-4 border-t border-ink/10 pt-6 sm:grid-cols-3">
              <div>
                <div className="text-sm font-medium text-ink">Fast to scan</div>
                <p className="mt-1 text-sm leading-6 text-ink/60">Clear hierarchy and restrained spacing keep the entry point readable.</p>
              </div>
              <div>
                <div className="text-sm font-medium text-ink">Built to scale</div>
                <p className="mt-1 text-sm leading-6 text-ink/60">The same scaffold handles local mode, Clerk auth, and worker-backed storage.</p>
              </div>
              <div>
                <div className="text-sm font-medium text-ink">Minimal surface</div>
                <p className="mt-1 text-sm leading-6 text-ink/60">No heavy chrome. The page stays focused on the primary action.</p>
              </div>
            </div>
          </div>
        </Panel>

        <Panel className="grid gap-5 rounded-[28px] border-ink/8 bg-white/72 p-8 shadow-none backdrop-blur-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-ink/45">Included</div>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">What ships in this scaffold</h2>
            </div>
            <div className="rounded-full border border-ink/10 bg-white px-3 py-1 text-xs text-ink/55">Ready</div>
          </div>
          <ul className="grid gap-3 text-sm leading-6 text-ink/68">
            <li className="rounded-2xl border border-ink/10 bg-white px-4 py-3">Rich text editing with image, audio, and video insertion.</li>
            <li className="rounded-2xl border border-ink/10 bg-white px-4 py-3">Cloud sync with revision checks for multiple devices.</li>
            <li className="rounded-2xl border border-ink/10 bg-white px-4 py-3">AI chat for note-level questions and text substitutions.</li>
            <li className="rounded-2xl border border-ink/10 bg-white px-4 py-3">Worker APIs for D1, R2, OpenAI, Gemini, and custom provider settings.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
