import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

export default function HomePage() {
  return (
    <div className="grid gap-6 py-8 lg:grid-cols-[1.2fr,0.8fr]">
      <Panel className="bg-[linear-gradient(140deg,#fffef8,#f0eadb)] p-8">
        <div className="max-w-2xl">
          <div className="rounded-full bg-white px-3 py-1 text-xs uppercase tracking-[0.25em] text-ink/60">Next.js + Workers</div>
          <h1 className="mt-6 font-display text-5xl leading-tight sm:text-6xl">A synced writing studio with AI edits, media embeds, and edge storage.</h1>
          <p className="mt-5 max-w-xl text-base text-ink/70">
            Nody combines a rich text editor, Clerk auth, Cloudflare D1 and R2 sync, and user-configurable OpenAI or Gemini backends.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/workspace">
              <Button className="bg-ink text-white hover:bg-ink/90">Open workspace</Button>
            </Link>
            <Link href="/sign-up">
              <Button type="button">Create account</Button>
            </Link>
          </div>
        </div>
      </Panel>
      <Panel className="grid gap-4 bg-pine text-white">
        <div>
          <div className="text-xs uppercase tracking-[0.25em] text-white/60">Included</div>
          <h2 className="mt-3 text-3xl font-semibold">What ships in this scaffold</h2>
        </div>
        <ul className="grid gap-3 text-sm text-white/80">
          <li>Rich text editing with image, audio, and video insertion.</li>
          <li>Cloud sync model with revision checks for multiple devices.</li>
          <li>Simple AI chat that can answer about the whole note and suggest substitutions.</li>
          <li>Worker APIs for D1, R2, OpenAI, Gemini, and custom provider settings.</li>
        </ul>
      </Panel>
    </div>
  );
}
