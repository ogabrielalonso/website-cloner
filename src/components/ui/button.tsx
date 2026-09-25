"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Starter button for the empty scaffold. A clone replaces its look with the
// target site's own buttons; the API (variant, size, className) stays stable.
const base = [
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap select-none",
  "rounded-md border border-transparent text-sm font-medium",
  "transition-colors outline-none",
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  "disabled:pointer-events-none disabled:opacity-50",
  "aria-invalid:border-destructive",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
].join(" ");

const buttonVariants = cva(base, {
  variants: {
    variant: {
      default: "bg-primary text-primary-foreground hover:bg-primary/85",
      secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/75",
      outline: "border-border bg-background hover:bg-muted",
      ghost: "hover:bg-muted",
      destructive: "bg-destructive text-white hover:bg-destructive/85",
      link: "text-primary underline-offset-4 hover:underline",
    },
    size: {
      xs: "h-6 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
      sm: "h-7 px-2.5 text-[0.8rem]",
      default: "h-8 px-3",
      lg: "h-10 px-4",
      "icon-xs": "size-6",
      "icon-sm": "size-7",
      icon: "size-8",
      "icon-lg": "size-10",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

type ButtonProps = BaseButton.Props & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...rest }: ButtonProps) {
  return (
    <BaseButton
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    />
  );
}

export { Button, buttonVariants };
