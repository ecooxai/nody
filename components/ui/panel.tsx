import type { ComponentPropsWithoutRef } from "react";

export function Panel({
  children,
  className = "",
  style,
  ...props
}: ComponentPropsWithoutRef<"section">) {
  return (
    <section className={`rounded-[4px] bg-white/90 p-5 text-ink shadow-panel ${className}`} style={style} {...props}>
      {children}
    </section>
  );
}
