import React from "react";
import { Link } from "react-router-dom";

export type ButtonVariant = "primary" | "secondary" | "white" | "outline" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  to?: string;
  href?: string;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
  loading?: boolean;
  fullWidth?: boolean;
  /** Link-only attributes, used when `href` is set. */
  target?: string;
  rel?: string;
}

const variantStyles: Record<ButtonVariant, string> = {
  // Vibrant orange with subtle inner rim highlight, soft outer glow, and modern depth
  primary:
    "bg-accent hover:bg-accent-hover text-white font-medium border border-orange-400/30 " +
    "shadow-[0_1px_2px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.22)] " +
    "hover:shadow-[0_0_24px_rgba(255,77,0,0.38),0_1px_3px_rgba(0,0,0,0.4)] " +
    "active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.3)]",

  // Sleek monochromatic white with dark text, crisp bevel, and soft ambient reflection
  white:
    "bg-white hover:bg-zinc-100 text-zinc-950 font-semibold border border-white/80 " +
    "shadow-[0_1px_3px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,1)] " +
    "hover:shadow-[0_0_20px_rgba(255,255,255,0.25)] " +
    "active:bg-zinc-200",

  // Modern dark surface using shades of black/zinc with subtle highlight line
  secondary:
    "bg-zinc-900/90 hover:bg-zinc-800 text-zinc-100 font-medium " +
    "border border-zinc-700/70 hover:border-zinc-500 " +
    "shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.08)] " +
    "hover:text-white hover:shadow-[0_0_15px_rgba(255,255,255,0.06)]",

  // Minimal refined outline
  outline:
    "bg-transparent hover:bg-white/[0.06] text-zinc-300 hover:text-white " +
    "border border-zinc-700/80 hover:border-zinc-400 active:bg-white/[0.1] font-medium",

  // Borderless ghost
  ghost:
    "bg-transparent hover:bg-white/[0.08] text-zinc-400 hover:text-white active:bg-white/[0.12] font-medium",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "text-xs px-3.5 py-1.5 rounded-lg gap-1.5 tracking-tight",
  md: "text-sm px-5 py-2.5 rounded-xl gap-2 tracking-tight",
  lg: "text-base px-7 py-3.5 rounded-xl gap-2.5 tracking-tight font-semibold",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      to,
      href,
      icon,
      iconPosition = "right",
      loading = false,
      fullWidth = false,
      className = "",
      children,
      disabled,
      target,
      rel,
      ...rest
    },
    ref
  ) => {
    const baseClasses =
      "group relative inline-flex items-center justify-center select-none cursor-pointer " +
      "transition-all duration-200 ease-out " +
      "active:scale-[0.98] " +
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black " +
      "disabled:opacity-50 disabled:pointer-events-none disabled:active:scale-100 " +
      variantStyles[variant] +
      " " +
      sizeStyles[size] +
      (fullWidth ? " w-full" : "") +
      (className ? ` ${className}` : "");

    const content = (
      <>
        {loading && (
          <svg
            className="animate-spin -ml-1 mr-2 h-4 w-4 text-current"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {!loading && icon && iconPosition === "left" && (
          <span className="transition-transform duration-200 group-hover:-translate-x-0.5">
            {icon}
          </span>
        )}
        <span>{children}</span>
        {!loading && icon && iconPosition === "right" && (
          <span className="transition-transform duration-200 group-hover:translate-x-0.5">
            {icon}
          </span>
        )}
      </>
    );

    if (to) {
      return (
        <Link
          to={to}
          className={baseClasses}
          id={rest.id}
          onClick={rest.onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}
        >
          {content}
        </Link>
      );
    }

    if (href) {
      return (
        <a
          href={href}
          className={baseClasses}
          id={rest.id}
          target={target}
          rel={rel}
          onClick={rest.onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}
        >
          {content}
        </a>
      );
    }

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={baseClasses}
        {...rest}
      >
        {content}
      </button>
    );
  }
);

Button.displayName = "Button";
