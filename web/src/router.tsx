import { useEffect, useState, type AnchorHTMLAttributes } from "react";
import { stripBase, withBase } from "./env";

// A small history router: three kinds of page, no dependency.
export function usePath() {
  const [path, setPath] = useState(stripBase(window.location.pathname));
  useEffect(() => {
    const on = () => setPath(stripBase(window.location.pathname));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

export function navigate(to: string) {
  if (withBase(to) === window.location.pathname + window.location.hash) return;
  window.history.pushState({}, "", withBase(to));
  window.dispatchEvent(new PopStateEvent("popstate"));
  const hash = to.split("#")[1];
  if (hash) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth" }));
  else window.scrollTo({ top: 0 });
}

export function Link({ to, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={withBase(to)}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
