// The frame of every sign-in screen: one column at phone width, the product name, a heading, then
// the screen's content. FocusedPanel (focused-panel.tsx) is the same frame for a screen that changes.
export const PANEL_MAIN = 'mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-5 px-4 py-8';
export const PANEL_HEADING = 'text-2xl font-semibold leading-tight outline-none';
export const PANEL_BODY = 'flex flex-col gap-4 text-base';

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className={PANEL_MAIN}>
      <p className="text-sm font-semibold tracking-wide">DryScope</p>
      <h1 className={PANEL_HEADING}>{title}</h1>
      <div className={PANEL_BODY}>{children}</div>
    </main>
  );
}
