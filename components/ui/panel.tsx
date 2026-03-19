export function Panel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <section className={`rounded-[4px] border border-ink/10 bg-white/90 p-5 text-ink shadow-panel ${className}`}>{children}</section>;
}
