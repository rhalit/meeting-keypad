// Overlay card window. Plain browser script (no imports); shares the global script scope with
// panel.ts at compile time, so everything lives inside one block. Card shapes: TermCard and
// TextCard in src/pipeline/overlay.ts.

interface OverlayTermMsg {
  kind: "term";
  id: number;
  term: string;
  title: string;
  category: string;
  color: string;
  explanation: string;
  example: string;
  /** Live term whose explanation is still on its way ("Explaining…"). */
  pending: boolean;
  durationMs: number | null;
}
interface OverlayTextMsg {
  kind: "text";
  id: number;
  eyebrow: string;
  title: string;
  body: string;
  tone: "info" | "success" | "error";
  streaming: boolean;
  durationMs: number | null;
}
type OverlayCardMsg = OverlayTermMsg | OverlayTextMsg;
interface OverlayApi {
  onCard(cb: (card: OverlayCardMsg) => void): void;
  onUpdate(cb: (card: OverlayCardMsg) => void): void;
  onReveal(cb: (id: number) => void): void;
  onHide(cb: () => void): void;
  onTheme(cb: (theme: string) => void): void;
  sized(id: number, height: number): void;
  shown(id: number): void;
  interactive(on: boolean): void;
  close(): void;
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
  const exampleLabel = el<HTMLDivElement>("example-label");
  const textEyebrow = el<HTMLDivElement>("text-eyebrow");
  const textTitle = el<HTMLHeadingElement>("text-title");
  const textBody = el<HTMLDivElement>("text-body");
  const bar = el<HTMLDivElement>("bar");

  let currentId = -1;
  let duration: number | null = null;
  let revealed = false;
  let barFor = -1;

  /** .card margin in overlay.css (room for its shadow inside the window). */
  const CARD_MARGIN = 4;
  const BULLET = /^\s*[-•*]\s+/;
  const PREFIX = /^([A-Za-z][A-Za-z ]{0,14}):\s+/;

  /** Body text -> paragraphs and bullet lists, textContent only. */
  function renderBody(body: string, streaming: boolean): void {
    const nodes: HTMLElement[] = [];
    let list: HTMLUListElement | null = null;
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let host: HTMLElement;
      let text = line;
      if (BULLET.test(line)) {
        if (!list) {
          list = document.createElement("ul");
          nodes.push(list);
        }
        host = document.createElement("li");
        list.append(host);
        text = line.replace(BULLET, "");
      } else {
        list = null;
        host = document.createElement("p");
        nodes.push(host);
      }
      const m = PREFIX.exec(text);
      if (m) {
        const strong = document.createElement("strong");
        strong.textContent = `${m[1]}:`;
        host.append(strong, ` ${text.slice(m[0].length)}`);
      } else {
        host.textContent = text;
      }
    }
    if (streaming) {
      const caret = document.createElement("span");
      caret.className = "caret";
      const last = list?.lastElementChild ?? nodes[nodes.length - 1];
      if (last instanceof HTMLElement) last.append(caret);
      else {
        const p = document.createElement("p");
        p.className = "thinking";
        p.textContent = "Thinking";
        p.append(caret);
        nodes.push(p);
      }
    }
    textBody.replaceChildren(...nodes);
  }

  function startBar(ms: number): void {
    barFor = currentId;
    bar.style.animation = "none";
    void bar.offsetWidth;
    bar.style.animation = `countdown ${ms}ms linear forwards`;
  }

  function render(c: OverlayCardMsg): void {
    card.dataset.kind = c.kind;
    if (c.kind === "term") {
      card.dataset.tone = "";
      title.textContent = c.title;
      chip.textContent = c.category;
      chip.style.setProperty("--cat", c.color);
      explanation.textContent = c.explanation;
      explanation.classList.toggle("thinking", c.pending);
      if (c.pending) {
        const caret = document.createElement("span");
        caret.className = "caret";
        explanation.append(caret);
      }
      example.textContent = c.example;
      example.hidden = c.example === "";
      exampleLabel.hidden = c.example === "";
    } else {
      card.dataset.tone = c.tone;
      textEyebrow.textContent = c.eyebrow;
      textTitle.textContent = c.title;
      textBody.hidden = c.body === "" && !c.streaming;
      renderBody(c.body, c.streaming);
    }
    duration = c.durationMs;
  }

  window.overlay.onCard((c) => {
    currentId = c.id;
    revealed = false;
    barFor = -1;
    bar.style.animation = "none";
    bar.style.transform = "scaleX(1)";
    render(c);
    card.classList.toggle("no-timer", c.durationMs === null);
    window.overlay.sized(c.id, card.getBoundingClientRect().height + CARD_MARGIN * 2);
  });

  window.overlay.onUpdate((c) => {
    if (c.id !== currentId) return;
    render(c);
    card.classList.toggle("no-timer", c.durationMs === null);
    if (revealed && duration !== null && barFor !== c.id) startBar(duration);
    window.overlay.sized(c.id, card.getBoundingClientRect().height + CARD_MARGIN * 2);
  });

  window.overlay.onReveal((id) => {
    if (id !== currentId) return;
    revealed = true;
    if (duration !== null) startBar(duration);
    document.body.classList.add("visible");
    // Two frames: the first one with the new content has been composited.
    requestAnimationFrame(() => requestAnimationFrame(() => window.overlay.shown(id)));
  });

  window.overlay.onHide(() => document.body.classList.remove("visible"));

  // × : the window is click-through, so it asks for clicks only while the pointer is on the button.
  const closeBtn = el<HTMLButtonElement>("close");
  closeBtn.addEventListener("mouseenter", () => window.overlay.interactive(true));
  closeBtn.addEventListener("mouseleave", () => window.overlay.interactive(false));
  closeBtn.addEventListener("click", () => {
    window.overlay.interactive(false);
    window.overlay.close();
  });
  window.overlay.onTheme((theme) => {
    document.documentElement.dataset.theme = theme;
  });
}
