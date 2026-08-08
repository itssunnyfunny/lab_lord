"use client";

import { CSSProperties, ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type LandingRevealVariant = "up" | "left" | "right" | "scale";

type LandingRevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  variant?: LandingRevealVariant;
  alwaysVisible?: boolean;
};

export function LandingReveal({
  children,
  className,
  delay = 0,
  variant = "up",
  alwaysVisible = false,
}: LandingRevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    if (alwaysVisible) return;

    const element = ref.current;
    if (!element) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const bounds = element.getBoundingClientRect();
    const isAlreadyInView = bounds.top < window.innerHeight * 0.88 && bounds.bottom > 0;
    if (isAlreadyInView) return;

    let observer: IntersectionObserver | undefined;
    const animationFrame = window.requestAnimationFrame(() => {
      setIsVisible(false);
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry?.isIntersecting) {
            setIsVisible(true);
            observer?.disconnect();
          }
        },
        {
          rootMargin: "0px 0px -12% 0px",
          threshold: 0.16,
        },
      );

      observer.observe(element);
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer?.disconnect();
    };
  }, [alwaysVisible]);

  return (
    <div
      ref={ref}
      className={cn("landing-scroll-reveal", className)}
      data-landing-variant={variant}
      data-visible={isVisible ? "true" : "false"}
      style={{ "--landing-reveal-delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}
