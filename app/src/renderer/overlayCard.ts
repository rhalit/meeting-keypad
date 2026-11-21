// Overlay card window. Plain browser script (no imports); shares the global script scope with
// panel.ts at compile time, so everything lives inside one block. Card shape: OverlayCard in
// src/pipeline/overlay.ts.

interface OverlayCardMsg {
  id: number;
  term: string;
  title: string;
  category: string;
  color: string;
  explanation: string;
  example: string;
  durationMs: number;
}
interface OverlayApi {
  onCard(cb: (card: OverlayCardMsg) => void): void;
  onReveal(cb: (id: number) => void): void;
  onHide(cb: () => void): void;
  sized(id: number, height: number): void;
  shown(id: number): void;
}
interface Window {
  overlay: OverlayApi;
}

{
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const card = el<HTMLDivElement>("card");
  const title = el<HTMLHeadingElement>("title");
  const chip = el<HTMLSpanElement>("chip");
  const explanation = el<HTMLParagraphElement>("explanation");
  const example = el<HTMLQuoteElement>("example");
  const bar = el<HTMLDivElement>("bar");
  let duration = 15_000;

  window.overlay.onCard((c) => {
    title.textContent = c.title;
    chip.textContent = c.category;
    chip.style.backgroundColor = c.color;
    explanation.textContent = c.explanation;
    example.textContent = c.example;
    duration = c.durationMs;
    window.overlay.sized(c.id, card.getBoundingClientRect().height);
  });

  window.overlay.onReveal((id) => {
    // Restart the countdown bar for this card.
    bar.style.animation = "none";
    void bar.offsetWidth;
    bar.style.animation = `countdown ${duration}ms linear forwards`;
    document.body.classList.add("visible");
    // Two frames: the first one with the new content has been composited.
    requestAnimationFrame(() => requestAnimationFrame(() => window.overlay.shown(id)));
  });

  window.overlay.onHide(() => document.body.classList.remove("visible"));
}
