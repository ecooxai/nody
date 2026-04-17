export function Panel({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section className={`rounded-[4px] bg-white/90 p-5 text-ink shadow-panel ${className}`} style={style}>
      {children}
    </section>
  );
}
