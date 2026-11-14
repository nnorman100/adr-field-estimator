'use client';

import { useEffect, useRef, type RefObject } from 'react';

// The signature pad (S5a-11): a canvas the customer draws on with a finger, stylus or mouse. Pointer
// events cover all three, including iPhone Safari; `touch-action: none` keeps a stroke from
// scrolling the page, and pointer capture keeps a stroke going when the finger leaves the box. The
// bitmap is sized to the box at the device's pixel ratio, on white, so the stored PNG is sharp and
// reads the same on any screen. A signature is drawn by hand, so there is no keyboard alternative to
// drawing (WCAG 2.5.7's exception for an essential path); the name is typed beside it.

const INK = '#111827';

/** Clears the pad to white at its current size. */
export function clearPad(canvas: HTMLCanvasElement): void {
  const ratio = window.devicePixelRatio || 1;
  const box = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(box.width * ratio));
  canvas.height = Math.max(1, Math.round(box.height * ratio));
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, box.width, box.height);
  context.strokeStyle = INK;
  context.fillStyle = INK;
  context.lineWidth = 2.5;
  context.lineCap = 'round';
  context.lineJoin = 'round';
}

/** The drawn signature as PNG bytes, or null when the browser cannot make them. */
export function padPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) return resolve(null);
      blob.arrayBuffer().then(
        (buffer) => resolve(new Uint8Array(buffer)),
        () => resolve(null),
      );
    }, 'image/png');
  });
}

export function SignaturePad({
  canvasRef,
  locked,
  labelledBy,
  onDrawn,
  onCleared,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  // While a signature is being sent (and after), the drawing cannot change.
  locked: boolean;
  labelledBy: string;
  onDrawn: () => void;
  // The pad was cleared because its box changed size (the phone turned): the drawing is gone.
  onCleared: () => void;
}) {
  const last = useRef<{ x: number; y: number } | null>(null);
  const width = useRef(0);
  const lockedRef = useRef(locked);
  const clearedRef = useRef(onCleared);
  useEffect(() => {
    lockedRef.current = locked;
    clearedRef.current = onCleared;
  });

  // Sized to its box now, and again when the box's width changes, unless a signature is being sent:
  // the bitmap must match the box, or strokes land away from the finger.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    clearPad(canvas);
    width.current = canvas.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const now = canvas.getBoundingClientRect().width;
      if (now === width.current || lockedRef.current) return;
      width.current = now;
      clearPad(canvas);
      clearedRef.current();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasRef]);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function down(event: React.PointerEvent<HTMLCanvasElement>) {
    if (locked || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = point(event);
    last.current = at;
    const context = event.currentTarget.getContext('2d');
    // A tap leaves a dot.
    context?.beginPath();
    context?.arc(at.x, at.y, 1.25, 0, Math.PI * 2);
    context?.fill();
    onDrawn();
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (locked || !last.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    const at = point(event);
    context.beginPath();
    context.moveTo(last.current.x, last.current.y);
    context.lineTo(at.x, at.y);
    context.stroke();
    last.current = at;
  }

  function up() {
    last.current = null;
  }

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-labelledby={labelledBy}
      data-testid="signature-pad"
      className="block h-44 w-full rounded-md border-2 border-dashed border-gray-500 bg-white [-webkit-user-select:none] [touch-action:none] select-none"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
    />
  );
}
