import { Panel } from "@/components/ui/panel";

export function SyncStatusCard({
  revision,
  status,
  updatedAt,
}: {
  revision: number;
  status: string;
  updatedAt: string;
}) {
  return (
    <Panel className="bg-pine text-white">
      <div className="text-xs uppercase tracking-[0.25em] text-white/60">Cloud sync</div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <div className="text-2xl font-semibold">{status}</div>
          <div className="mt-1 text-sm text-white/70">Revision {revision}</div>
        </div>
        <div className="text-right text-xs text-white/70">{updatedAt}</div>
      </div>
    </Panel>
  );
}
