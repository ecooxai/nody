import type { ButtonHTMLAttributes } from "react";

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`rounded-[4px] border border-ink/10 bg-white px-4 py-2 text-sm font-medium text-ink transition hover:border-ink/30 hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}
